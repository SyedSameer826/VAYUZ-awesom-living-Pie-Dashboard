// ============================================================================
// Room Occupancy Service — 3-device state machine for occupancy detection.
//
// Devices:
//   1. Curtain Sensor (threshold_motion) — PIR outside the gate
//   2. Door/Contact Sensor (occupancy_door) — on the gate
//   3. Master Motion Sensor (room_motion) — PIR inside the room
//
// ENTRY:
//   TRIGGER: curtain=true OR door opens while vacant → entry_pending
//   CONFIRM: master=true + door is closed + not door-swing (2s debounce)
//            → occupied
//   TIMEOUT: 60s without confirmation → back to vacant
//   DIRECT FALLBACK: master=true while vacant → occupied immediately
//
// EXIT:
//   TRIGGER: curtain=true while occupied → exit_pending (silence window
//            starts), BUT only if master did NOT just activate within
//            15s (entry grace period — curtain fires bidirectionally,
//            so a recent master activation means entry, not exit)
//   CANCEL:  master=true while exit_pending → back to occupied
//   CONFIRM: 120s silence (no master=true), then:
//     exit_door_opened = true  → vacant (door opened at some point)
//     exit_door_opened = false → occupied (door never opened, not a real
//                                exit — curtain false-trigger)
//
//   exit_door_opened lifecycle:
//     - Reset to false on EVERY transition to occupied (new stay starts)
//     - Set to true when door opens during occupied or exit_pending
//     - NOT reset when exit is cancelled (persists for rest of stay)
//
// STILLNESS ALERT:
//   master=false while occupied + no sensor activity for threshold →
//   notification "someone is in the room but no motion detected"
//
// State machine: Vacant → Entry Pending → Occupied → Exit Pending → Vacant
// ============================================================================

import room_occupancy_state from '../models/room_occupancy_state.js';
import room_occupancy_settings from '../models/room_occupancy_settings.js';
import resident_model from '../models/resident.js';
import socket_service from '../utils/socket.js';
import alert_log from '../models/alert_log.js';
import { dispatch_notification, is_alert_muted } from './notification_service.js';
import { DeviceCategory } from '../constants/notification_events.js';
import zigbee_logs_service from './health_logs.js';
import { get_device_details } from './device_service.js';

// ── Reset constants ─────────────────────────────────────────────────────────

const entry_reset = {
  entry_started_at: null,
  // Clear legacy step fields from previous state machine version
  entry_step: 0,
  entry_master_confirmed: false,
  entry_curtain_cleared: false,
};

const exit_reset = {
  exit_started_at: null,
  exit_silence_start_at: null,
  // Clear legacy fields from previous state machine version
  exit_step: 0,
  exit_curtain_triggered: false,
};

const stillness_reset = {
  stillness_alert_sent: false,
  stillness_alert_sent_at: null,
  stillness_alert_log_id: null,
};

const long_stay_reset = {
  long_stay_level_reached: 0,
  long_stay_level_1_time: null,
  long_stay_level_1_log_id: null,
  long_stay_level_2_time: null,
  long_stay_level_2_log_id: null,
  long_stay_level_3_time: null,
  long_stay_level_3_log_id: null,
  long_stay_last_emergency_repeat_at: null,
};

const safety_ceiling_reset = {
  safety_ceiling_alert_sent: false,
  safety_ceiling_alert_time: null,
  safety_ceiling_alert_log_id: null,
};

const all_alerts_reset = {
  ...stillness_reset,
  ...long_stay_reset,
  ...safety_ceiling_reset,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const get_or_create_state = async (resident_id, occupancy_group) => {
  return room_occupancy_state.findOneAndUpdate(
    { resident: resident_id, occupancy_group },
    { $setOnInsert: { resident: resident_id, occupancy_group } },
    { upsert: true, new: true },
  );
};

// ── Test mode flag ──────────────────────────────────────────────────────────
// Set to true for quick walk-testing, false for production timers
const test_mode_enabled = true;

const production_timers = {
  entry_window_sec: 60,
  exit_silence_sec: 120,
  stillness_threshold_min: 1,
  long_stay_level_1_min: 30,
  long_stay_level_2_min: 35,
  long_stay_level_3_min: 40,
  emergency_repeat_interval_min: 5,
  safety_ceiling_hours: 4,
};

const test_timers = {
  entry_window_sec: 60,
  exit_silence_sec: 120,
  stillness_threshold_min: 1,
  long_stay_level_1_min: 3,
  long_stay_level_2_min: 3.5,
  long_stay_level_3_min: 4,
  emergency_repeat_interval_min: 0.5,
  safety_ceiling_hours: 4,
};

const get_settings = async (resident_id, occupancy_group) => {
  const settings = await room_occupancy_settings
    .findOne({ resident: resident_id, occupancy_group, is_active: true })
    .lean();

  if (settings) return settings;

  const timers = test_mode_enabled ? test_timers : production_timers;
  return { ...timers, test_mode: test_mode_enabled };
};

// ── State translation map ───────────────────────────────────────────────────
// The occupancy state machine uses: vacant, entry_pending, occupied, exit_pending
// The app (room_state_update) expects: empty, activity_detected, occupied, just_left
const translate_state_for_app = (occupancy_state) => {
  switch (occupancy_state) {
    case 'vacant':
      return 'empty';
    case 'entry_pending':
      return 'activity_detected';
    case 'occupied':
      return 'occupied';
    case 'exit_pending':
      return 'just_left';
    default:
      return 'empty';
  }
};

// Room-level occupancy boolean: occupied/exit_pending → true, vacant/entry_pending → false
const is_room_occupied = (occupancy_state) =>
  occupancy_state === 'occupied' || occupancy_state === 'exit_pending';

// Emit socket events so the app can update Presence UI in real time.
// Emits three events:
//   1. room_occupancy_update  — raw state machine state (new occupancy UI)
//   2. room_state_update      — translated state for existing room state UI
//   3. bathroom_update        — backward-compat for the legacy bathroom screen
const emit_occupancy_update = (target_user, state_doc) => {
  if (!target_user?._id) {
    console.warn('[room-occupancy] emit skipped — no target_user._id');
    return;
  }
  const user_id_str = target_user._id.toString();

  // ── 1. room_occupancy_update (raw state machine) ──────────────────────
  const payload = {
    occupancy_group: state_doc.occupancy_group,
    resident: state_doc.resident,
    state: state_doc.state,
    occupied_since: state_doc.occupied_since,
    room_label: state_doc.room_label,
    master_is_active: state_doc.master_is_active,
    door_is_open: state_doc.door_is_open,
    exit_door_opened: state_doc.exit_door_opened,
  };
  console.log(
    `[room-occupancy] socket emit room_occupancy_update → ` +
      `user=${user_id_str} state=${payload.state}`,
  );
  socket_service.send_to_user(user_id_str, 'room_occupancy_update', payload);

  // ── 2. room_state_update (translated for existing app UI) ─────────────
  const app_state = translate_state_for_app(state_doc.state);
  const room_state_payload = {
    room: state_doc.room_label || 'Room',
    resident: state_doc.resident,
    state: app_state,
    occupancy: is_room_occupied(state_doc.state),
    motion_active: state_doc.master_is_active || false,
    occupied_since: state_doc.occupied_since,
    occupancy_group: state_doc.occupancy_group,
  };
  console.log(
    `[room-occupancy] socket emit room_state_update → ` +
      `user=${user_id_str} state=${app_state}`,
  );
  socket_service.send_to_user(user_id_str, 'room_state_update', room_state_payload);

  // ── 3. bathroom_update (backward-compat with legacy bathroom screen) ──
  (async () => {
    try {
      const motion_device = await get_device_details({
        occupancy_group: state_doc.occupancy_group,
        sensor_role: 'room_motion',
        status: 'active',
      });
      if (!motion_device) {
        console.warn(
          `[room-occupancy] bathroom_update skipped — no room_motion device for ${state_doc.occupancy_group}`,
        );
        return;
      }

      const device_name = motion_device.id || motion_device.zigbee_id;
      if (!device_name) {
        console.warn('[room-occupancy] bathroom_update skipped — no device name on room_motion');
        return;
      }

      const bathroom_data = await zigbee_logs_service.get_bathroom_data(device_name);

      // Override occupancy with the room-level combined state so the
      // bathroom card shows "occupied" when the multi-sensor state machine
      // says occupied, not just when the single PIR is active.
      bathroom_data.occupancy = is_room_occupied(state_doc.state);

      console.log(
        `[room-occupancy] socket emit bathroom_update → ` +
          `user=${user_id_str} occupancy=${bathroom_data.occupancy}`,
      );
      socket_service.send_to_user(user_id_str, 'bathroom_update', bathroom_data);
    } catch (err) {
      console.error('[room-occupancy] bathroom_update emit failed:', err.message);
    }
  })();
};

// ── Notification helpers ────────────────────────────────────────────────────

const send_motion_detected_notification = async (
  target_user,
  device_info,
  resident_info,
  occupancy_group,
  location_label,
) => {
  if (!target_user?._id) return;
  await dispatch_notification({
    backend_event: 'MOTION_DETECTED',
    user_id: target_user._id,
    template_vars: { location: location_label },
    data: {
      device: device_info.ieee_address || device_info.zigbee_id,
      device_id: device_info._id ? device_info._id.toString() : undefined,
      room: location_label,
      resident: resident_info._id ? resident_info._id.toString() : undefined,
      occupancy_group,
    },
  }).catch((err) => console.error('[occupancy] MOTION_DETECTED dispatch failed:', err.message));
};

const send_occupied_notification = async (
  target_user,
  device_info,
  resident_info,
  occupancy_group,
  location_label,
) => {
  if (!target_user?._id) return;
  await dispatch_notification({
    backend_event: 'ROOM_OCCUPIED',
    user_id: target_user._id,
    template_vars: { location: location_label },
    data: {
      device: device_info.ieee_address || device_info.zigbee_id,
      device_id: device_info._id ? device_info._id.toString() : undefined,
      room: location_label,
      resident: resident_info._id ? resident_info._id.toString() : undefined,
      occupancy_group,
    },
  }).catch((err) => console.error('[occupancy] ROOM_OCCUPIED dispatch failed:', err.message));
};

const send_vacant_notification = async (
  target_user,
  device_info,
  resident_info,
  occupancy_group,
  location_label,
) => {
  if (!target_user?._id) return;
  await dispatch_notification({
    backend_event: 'ROOM_VACANT',
    user_id: target_user._id,
    template_vars: { location: location_label },
    data: {
      device: device_info.ieee_address || device_info.zigbee_id,
      device_id: device_info._id ? device_info._id.toString() : undefined,
      room: location_label,
      resident: resident_info._id ? resident_info._id.toString() : undefined,
      occupancy_group,
    },
  }).catch((err) => console.error('[occupancy] ROOM_VACANT dispatch failed:', err.message));
};

// ── Event handlers ──────────────────────────────────────────────────────────

/**
 * Handle a curtain/threshold motion event (sensor outside the gate).
 *
 * ENTRY:
 *   curtain=true while vacant → entry_pending
 *
 * EXIT:
 *   curtain=true while occupied → exit_pending (silence window starts)
 */
const handle_threshold_motion = async ({
  target_user,
  device_info,
  resident_info,
  occupancy_group,
  data,
}) => {
  const state_doc = await get_or_create_state(resident_info._id, occupancy_group);
  const now = new Date();

  const updates = {
    last_curtain_event_at: now,
    threshold_device: device_info._id,
    curtain_is_active: !!data.occupancy,
  };

  if (data.occupancy) {
    // ── Curtain occupancy=true ─────────────────────────────────────────

    if (state_doc.state === 'vacant') {
      // ENTRY TRIGGER: curtain detects someone approaching.
      Object.assign(updates, {
        state: 'entry_pending',
        entry_started_at: now,
      });

      console.log(
        `[room-occupancy] ${occupancy_group} curtain=true → entry_pending`,
      );
    } else if (state_doc.state === 'occupied') {
      // ── Entry grace period check ──────────────────────────────────────
      // The curtain sensor fires bidirectionally — it can't tell entry
      // from exit. If the master PIR inside the room recently activated
      // (inactive → active), it means someone just walked IN. The curtain
      // fired because the person passed it on the way in, not out.
      // We skip the exit trigger during this grace window (15s).
      const entry_grace_ms = 15000;
      const last_activated = state_doc.last_master_activated_at
        ? new Date(state_doc.last_master_activated_at).getTime()
        : 0;
      const since_master_activated_ms = last_activated > 0
        ? now.getTime() - last_activated
        : Infinity;

      if (since_master_activated_ms < entry_grace_ms) {
        // Master just activated — this curtain trigger is from entry,
        // not exit. Ignore it.
        console.log(
          `[room-occupancy] ${occupancy_group} curtain=true while occupied → ` +
            `IGNORED (entry grace period, master activated ` +
            `${(since_master_activated_ms / 1000).toFixed(1)}s ago)`,
        );
      } else {
        // EXIT TRIGGER: curtain detects person at threshold while occupied,
        // and master has NOT recently activated — this looks like a real exit.
        Object.assign(updates, {
          state: 'exit_pending',
          exit_started_at: now,
          exit_silence_start_at: now,
        });

        console.log(
          `[room-occupancy] ${occupancy_group} curtain=true while occupied → ` +
            `exit_pending (silence window started)`,
        );
      }
    }
    // entry_pending + curtain=true → ignore (already in entry)
    // exit_pending + curtain=true → ignore (already in exit)
  }
  // curtain=false → just updates curtain_is_active flag, no state changes

  await room_occupancy_state.updateOne(
    { _id: state_doc._id },
    { $set: updates },
    { strict: false },
  );

  const updated = { ...state_doc.toObject(), ...updates };
  emit_occupancy_update(target_user, updated);

  // No notifications from curtain handler — entry is confirmed by master,
  // exit is confirmed by cron silence window.
};

/**
 * Handle a master room motion event (sensor inside the room).
 *
 * ENTRY:
 *   master=true while vacant → DIRECT FALLBACK → occupied
 *   master=true while entry_pending + door closed + no door-swing → occupied
 *
 * OCCUPIED:
 *   master=true → reset stillness tracking
 *   master=false → track for stillness detection
 *
 * EXIT:
 *   master=true while exit_pending → cancel exit, back to occupied
 *   master=false while exit_pending → just update flag (silence continues)
 */
const handle_room_motion = async ({
  target_user,
  device_info,
  resident_info,
  occupancy_group,
  data,
}) => {
  const state_doc = await get_or_create_state(resident_info._id, occupancy_group);
  const now = new Date();

  const updates = {
    last_master_event_at: now,
    room_motion_device: device_info._id,
  };

  const location_label = device_info.room || state_doc.room_label || 'Room';

  // Track when master transitions from inactive → active (for entry
  // grace period — helps curtain handler distinguish entry from exit).
  const master_just_activated =
    data.occupancy && !state_doc.master_is_active;

  if (data.occupancy) {
    // ── Master occupancy=true (person moving inside room) ──────────────

    // Record activation timestamp so curtain handler can check it.
    if (master_just_activated) {
      updates.last_master_activated_at = now;
    }

    if (state_doc.state === 'vacant') {
      // DIRECT FALLBACK: master fires in vacant → occupied immediately.
      // This covers cases where curtain or door didn't trigger first.
      Object.assign(updates, {
        state: 'occupied',
        occupied_since: now,
        master_is_active: true,
        exit_door_opened: false,
        ...entry_reset,
        ...all_alerts_reset,
      });

      console.log(
        `[room-occupancy] ${occupancy_group} master=true in vacant → ` +
          `DIRECT FALLBACK → occupied`,
      );
    } else if (state_doc.state === 'entry_pending') {
      // Check door-swing debounce: if a door event happened < 2s ago,
      // this master trigger might be from the door's physical movement,
      // not a person.
      const last_door_time = state_doc.last_door_event_at
        ? new Date(state_doc.last_door_event_at).getTime()
        : 0;
      const since_door_event_sec = last_door_time > 0
        ? (now.getTime() - last_door_time) / 1000
        : Infinity;

      if (since_door_event_sec < 2) {
        // Door swing — ignore this master event.
        updates.master_is_active = true;
        console.log(
          `[room-occupancy] ${occupancy_group} master=true during entry_pending → ` +
            `ignored (door swing, ${since_door_event_sec.toFixed(1)}s since door event)`,
        );
      } else if (!state_doc.door_is_open) {
        // Door is closed + not a door swing → ENTRY CONFIRMED.
        Object.assign(updates, {
          state: 'occupied',
          occupied_since: now,
          master_is_active: true,
          exit_door_opened: false,
          ...entry_reset,
          ...all_alerts_reset,
        });

        console.log(
          `[room-occupancy] ${occupancy_group} entry CONFIRMED → occupied ` +
            `(master=true + door closed)`,
        );
      } else {
        // Door is still open — can't confirm entry yet. Either a later
        // master event fires once the door closes, or entry times out.
        updates.master_is_active = true;
        console.log(
          `[room-occupancy] ${occupancy_group} master=true during entry_pending → ` +
            `door still open, waiting for door to close`,
        );
      }
    } else if (state_doc.state === 'occupied') {
      // Still moving — reset stillness tracking.
      updates.master_is_active = true;

      if (state_doc.stillness_alert_sent) {
        Object.assign(updates, stillness_reset);
        console.log(
          `[room-occupancy] ${occupancy_group} master motion resumed → ` +
            `stillness alert reset`,
        );
      }
    } else if (state_doc.state === 'exit_pending') {
      // Master detected movement during exit → person went back inside.
      // Cancel exit, revert to occupied. exit_door_opened is deliberately
      // NOT reset — if the door opened once during this stay, that's
      // remembered in case a real exit attempt follows later.
      Object.assign(updates, {
        state: 'occupied',
        master_is_active: true,
        exit_started_at: null,
        exit_silence_start_at: null,
      });

      console.log(
        `[room-occupancy] ${occupancy_group} master=true during exit → ` +
          `cancelling exit, back to occupied`,
      );
    }
  } else {
    // ── Master occupancy=false (PIR timeout — no movement) ────────────

    if (state_doc.state === 'occupied') {
      // Master says no movement in the room. Could be start of stillness
      // situation. Exit is only triggered by curtain, not by master=false.
      updates.master_is_active = false;
      updates.last_master_false_at = now;

      console.log(
        `[room-occupancy] ${occupancy_group} master=false while occupied → ` +
          `tracking for stillness`,
      );
    } else if (state_doc.state === 'exit_pending') {
      // Master=false during exit — just update flag. Exit completion is
      // handled by the cron silence window, not here.
      updates.master_is_active = false;
      updates.last_master_false_at = now;

      console.log(
        `[room-occupancy] ${occupancy_group} master=false during exit_pending → ` +
          `flag updated, silence window continues`,
      );
    }
    // entry_pending + master=false → ignore
    // vacant + master=false → ignore
  }

  await room_occupancy_state.updateOne(
    { _id: state_doc._id },
    { $set: updates },
    { strict: false },
  );

  const updated = { ...state_doc.toObject(), ...updates };
  emit_occupancy_update(target_user, updated);

  // ── Send notifications on state transitions ──────────────────────────
  if (
    updates.state === 'occupied' &&
    (state_doc.state === 'entry_pending' || state_doc.state === 'vacant')
  ) {
    await send_motion_detected_notification(
      target_user,
      device_info,
      resident_info,
      occupancy_group,
      location_label,
    );
    await send_occupied_notification(
      target_user,
      device_info,
      resident_info,
      occupancy_group,
      location_label,
    );
  }
  // No ROOM_VACANT from master handler — exit is completed by cron.
};

/**
 * Handle a door/contact sensor event (sensor on the gate).
 *
 * ENTRY:
 *   door opens while vacant → entry_pending
 *
 * OCCUPIED / EXIT_PENDING:
 *   door opens → set exit_door_opened = true (for exit confirmation)
 *
 * Door close during entry_pending makes the room "ready" for master
 * confirmation (master=true checks !door_is_open).
 */
const handle_occupancy_door = async ({
  target_user,
  device_info,
  resident_info,
  occupancy_group,
  data,
}) => {
  const state_doc = await get_or_create_state(resident_info._id, occupancy_group);
  const now = new Date();

  const updates = {
    door_device: device_info._id,
  };

  // Only update last_door_event_at when door state actually changes
  // (avoids repeated contact reports resetting the debounce timer)
  const door_changed =
    (data.contact === false && !state_doc.door_is_open) ||
    (data.contact === true && state_doc.door_is_open);
  if (door_changed) {
    updates.last_door_event_at = now;
  }

  if (data.contact === false) {
    // ── Door OPENED ─────────────────────────────────────────────────────
    updates.door_is_open = true;

    if (state_doc.state === 'vacant' && door_changed) {
      // ENTRY TRIGGER: door opens while vacant → entry_pending.
      Object.assign(updates, {
        state: 'entry_pending',
        entry_started_at: now,
      });

      console.log(
        `[room-occupancy] ${occupancy_group} door opened while vacant → entry_pending`,
      );
    } else if (
      (state_doc.state === 'occupied' || state_doc.state === 'exit_pending') &&
      door_changed
    ) {
      // Track that the door opened during this stay (for exit confirmation).
      updates.exit_door_opened = true;

      console.log(
        `[room-occupancy] ${occupancy_group} door opened while ${state_doc.state} → ` +
          `exit_door_opened=true`,
      );
    }
    // entry_pending + door open → just update door_is_open flag
  } else if (data.contact === true) {
    // ── Door CLOSED ─────────────────────────────────────────────────────
    updates.door_is_open = false;

    // Door closing doesn't directly change state. But updating door_is_open
    // to false allows the next master=true (during entry_pending) to confirm
    // entry, since the confirmation check requires !door_is_open.
    if (state_doc.state === 'entry_pending' && door_changed) {
      console.log(
        `[room-occupancy] ${occupancy_group} door closed during entry_pending → ` +
          `ready for master confirmation`,
      );
    }
    // occupied + door close → just update flag
    // exit_pending + door close → just update flag
    // vacant + door close → just update flag
  }

  await room_occupancy_state.updateOne(
    { _id: state_doc._id },
    { $set: updates },
    { strict: false },
  );

  const updated = { ...state_doc.toObject(), ...updates };
  emit_occupancy_update(target_user, updated);

  // No notifications from door handler — entry is confirmed by master,
  // exit is confirmed by cron silence window.
};

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Main entry point called from zigbee_service.select_device_send_data when
 * a device belongs to an occupancy_group.
 *
 * @param {string} sensor_role - 'threshold_motion' | 'room_motion' | 'occupancy_door'
 * @param {Object} body - { target_user, data, device, device_info, resident_info }
 */
const handle_occupancy_event = async (sensor_role, body) => {
  const { target_user, data, device_info } = body;
  let { resident_info } = body;

  if (!device_info?.occupancy_group) {
    console.warn(
      `[room-occupancy] missing occupancy_group on device ${device_info?.id || 'unknown'} — skipping`,
    );
    return;
  }

  // Resolve resident
  if (!resident_info?._id && device_info?.home) {
    const found = await resident_model.findOne({ home: device_info.home }).lean();
    if (found) resident_info = found;
  }
  if (!resident_info?._id) {
    console.warn(
      `[room-occupancy] no resident found for device ${device_info?.id || 'unknown'} ` +
        `(home=${device_info?.home || 'none'}) — skipping occupancy event`,
    );
    return;
  }

  const occupancy_group = device_info.occupancy_group;

  // Set room_label from device_info.room if state_doc doesn't have one yet
  const state_doc = await get_or_create_state(resident_info._id, occupancy_group);
  if (state_doc.room_label === 'Room' && device_info.room) {
    await room_occupancy_state.updateOne(
      { _id: state_doc._id },
      { $set: { room_label: device_info.room } },
    );
  }

  // ── Timeout checks ──────────────────────────────────────────────────────
  // Check if entry_pending has expired (handled inline, cron also checks).
  const settings = await get_settings(resident_info._id, occupancy_group);
  const entry_window_sec = settings.entry_window_sec ?? 60;

  if (state_doc.state === 'entry_pending' && state_doc.entry_started_at) {
    const elapsed = (Date.now() - new Date(state_doc.entry_started_at).getTime()) / 1000;
    if (elapsed > entry_window_sec) {
      console.log(
        `[room-occupancy] entry_pending expired for ${occupancy_group} — ` +
          `reverting to vacant (${elapsed.toFixed(0)}s elapsed, window=${entry_window_sec}s)`,
      );
      await room_occupancy_state.updateOne(
        { _id: state_doc._id },
        { $set: { state: 'vacant', ...entry_reset } },
      );
      emit_occupancy_update(target_user, {
        ...state_doc.toObject(),
        state: 'vacant',
        ...entry_reset,
      });
      // Don't process the current event against the expired state.
      // Reload the state for the event handler.
    }
  }

  const ctx = { target_user, device_info, resident_info, occupancy_group, data };

  const before_state = state_doc.state;
  console.log(
    `[room-occupancy] ${sensor_role} event | group=${occupancy_group} | ` +
      `current_state=${before_state} | data=${JSON.stringify(data)}`,
  );

  switch (sensor_role) {
    case 'threshold_motion':
      await handle_threshold_motion(ctx);
      break;
    case 'room_motion':
      await handle_room_motion(ctx);
      break;
    case 'occupancy_door':
      await handle_occupancy_door(ctx);
      break;
    default:
      console.warn(`[room-occupancy] unknown sensor_role: ${sensor_role}`);
  }

  // ── Post-handler diagnostic: read back state to confirm DB write ────
  try {
    const after = await room_occupancy_state
      .findOne({ resident: resident_info._id, occupancy_group })
      .lean();
    console.log(
      `[room-occupancy] ${sensor_role} done | state: ${before_state} → ${after?.state} | ` +
        `master_active=${after?.master_is_active} door_open=${after?.door_is_open} ` +
        `exit_door_opened=${after?.exit_door_opened} curtain_active=${after?.curtain_is_active}`,
    );
  } catch (read_err) {
    console.error(`[room-occupancy] ${sensor_role} post-read FAILED: ${read_err.message}`);
  }
};

export { handle_occupancy_event };
export default { handle_occupancy_event };
