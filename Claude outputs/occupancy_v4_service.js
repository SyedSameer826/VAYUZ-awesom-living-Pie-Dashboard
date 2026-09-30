// ============================================================================
// Occupancy V4 Service — two-sensor state machine (doorway PIR + inside PIR).
//
// Wires the pure occupancyStateMachine.cjs into the backend:
//   - Mongoose persistence (room_occupancy_v4_state)
//   - Socket.io live updates (room_occupancy_update, room_state_update,
//     bathroom_update)
//   - Push notifications via dispatch_notification
//   - alert_log entries for every family-audience event
//
// The state machine itself is NEVER edited — all adaptation happens here.
// ============================================================================

import { createRequire } from 'module';
import room_occupancy_v4_state from '../models/room_occupancy_v4_state.js';
import resident_model from '../models/resident.js';
import socket_service from '../utils/socket.js';
import alert_log from '../models/alert_log.js';
import { dispatch_notification, is_alert_muted } from './notification_service.js';
import { DeviceCategory } from '../constants/notification_events.js';
import { get_device_details } from './device_service.js';
import zigbee_logs_service from './health_logs.js';

// ── Import the CommonJS state machine into this ESM service ─────────────────
const require_cjs = createRequire(import.meta.url);
const { BathroomOccupancy, ROLES, STATES } = require_cjs('./occupancyStateMachine.cjs');

// ── In-memory machine cache ─────────────────────────────────────────────────
// Key: `${resident_id}:${occupancy_group}` → BathroomOccupancy instance.
// Hydrated lazily on first event; snapshot persisted after every dirty tick.
const machines = new Map();

const cache_key = (resident_id, occupancy_group) =>
  `${String(resident_id)}:${occupancy_group}`;

// ── Resolve helpers ─────────────────────────────────────────────────────────

const resolve_resident_for_device = async (device_info, resident_info) => {
  if (resident_info) return resident_info;
  if (!device_info?.home) return null;
  return resident_model.findOne({ home: device_info.home }).lean();
};

// ── State translation (v4 states → app vocabulary) ──────────────────────────
// The app expects: empty, activity_detected, occupied, just_left.
const translate_state_for_app = (v4_state) => {
  switch (v4_state) {
    case STATES.TENTATIVE:
      return 'activity_detected';
    case STATES.OCCUPIED:
    case STATES.CHECKING:
    case STATES.ALERTED:
    case STATES.DEGRADED:
      return 'occupied';
    case STATES.EXIT_PENDING:
      return 'just_left';
    case STATES.AWAY:
    case STATES.VACANT:
    default:
      return 'empty';
  }
};

const is_room_occupied = (v4_state) =>
  [STATES.OCCUPIED, STATES.CHECKING, STATES.ALERTED, STATES.DEGRADED, STATES.EXIT_PENDING]
    .includes(v4_state);

// ── Socket emit (mirrors v3 room_occupancy_service pattern) ─────────────────

const emit_occupancy_update = (target_user, occupancy_group, room_label, sm) => {
  if (!target_user?._id) return;
  const user_id_str = target_user._id.toString();
  const occupied = is_room_occupied(sm.state);

  // 1. room_occupancy_update — raw state for new occupancy UI
  const payload = {
    occupancy_group,
    state: sm.state,
    occupied_since: sm.enteredAt ? new Date(sm.enteredAt).toISOString() : null,
    room_label,
    version: 4,
  };
  console.log(
    `[occupancy-v4] socket emit room_occupancy_update → ` +
      `user=${user_id_str} state=${sm.state}`,
  );
  socket_service.send_to_user(user_id_str, 'room_occupancy_update', payload);

  // 2. room_state_update — translated state for existing room state UI
  const app_state = translate_state_for_app(sm.state);
  socket_service.send_to_user(user_id_str, 'room_state_update', {
    room: room_label,
    state: app_state,
    occupancy: occupied,
    occupancy_group,
  });

  // 3. bathroom_update — backward-compat with legacy bathroom screen
  (async () => {
    try {
      // v4 uses 'inside' role sensor as the main motion reference
      const motion_device = await get_device_details({
        occupancy_group,
        sensor_role: 'inside',
        status: 'active',
      });
      if (!motion_device) return;

      const device_name = motion_device.id || motion_device.zigbee_id;
      if (!device_name) return;

      const bathroom_data = await zigbee_logs_service.get_bathroom_data(device_name);
      bathroom_data.occupancy = occupied;

      socket_service.send_to_user(user_id_str, 'bathroom_update', bathroom_data);
    } catch (err) {
      console.error('[occupancy-v4] bathroom_update emit failed:', err.message);
    }
  })();
};

// ── Notification copy — fixed wording per spec 5.3 ──────────────────────────
// Never "fall". Never a name. Always "someone".

const family_copy = (evt) => {
  const mins = Math.round((evt.silenceS || 0) / 60);
  switch (evt.type) {
    case 'inactivity_alert':
    case 'alert_repeat':
      return {
        title: 'No movement detected',
        body: `No movement detected in the bathroom for ${mins} minutes. ` +
              `Someone may need help. Please check.`,
      };
    case 'all_clear':
      return {
        title: 'Movement detected again',
        body: `Movement detected again in the bathroom at ` +
              `${new Date(evt.tsMs).toLocaleTimeString('en-IN')}.`,
      };
    case 'long_stay':
      return {
        title: 'Extended stay',
        body: `Someone has been in the bathroom for ${evt.minutes} minutes.`,
      };
    case 'safety_ceiling':
      return {
        title: 'Please check',
        body: `Someone has been in the bathroom for ${evt.hours} hours. Please check.`,
      };
    default:
      return { title: 'Awesom Living', body: 'Update from the home.' };
  }
};

// ── Event dispatch — called by the state machine for every event ────────────

const create_event_handler = (context) => async (evt) => {
  const { target_user, resident_info, occupancy_group, room_label } = context;

  // Log every event
  console.log(
    `[occupancy-v4] event=${evt.type} state=${evt.state} ` +
      `audience=${evt.audience} room=${occupancy_group}`,
  );

  // Live state to the app on EVERY event (spec 7.4) — socket only
  if (context.sm) {
    emit_occupancy_update(target_user, occupancy_group, room_label, context.sm);
  }

  // Log-only and ops events: no push to family
  if (evt.audience === 'ops') {
    // Ops events → alert_log only, no push
    try {
      await alert_log.create({
        title: `[ops] ${evt.type}`,
        description: JSON.stringify(evt),
        resident: resident_info?._id,
        device_type: 'zigbee',
        alert_level: 'info',
        is_resolved: evt.type === 'monitoring_restored' || evt.type === 'sensor_online',
        meta: {
          sensor_type: 'occupancy_v4',
          occupancy_group,
          room: room_label,
          event_type: evt.type,
          v4: true,
        },
      });
    } catch (err) {
      console.error('[occupancy-v4] ops alert_log write failed:', err.message);
    }
    return;
  }

  if (evt.audience !== 'family') return; // 'none' = log + socket only

  // ── Family-audience events → alert_log + push notification ────────────
  const copy = family_copy(evt);
  const is_critical = !!evt.critical;

  // Determine backend_event key and alert_level
  let backend_event;
  let alert_level;
  let severity_override;

  switch (evt.type) {
    case 'inactivity_alert':
      backend_event = 'V4_INACTIVITY_ALERT';
      alert_level = 'emergency';
      severity_override = 'emergency';
      break;
    case 'alert_repeat':
      backend_event = 'V4_ALERT_REPEAT';
      alert_level = 'emergency';
      severity_override = 'emergency';
      break;
    case 'all_clear':
      backend_event = 'V4_ALL_CLEAR';
      alert_level = 'info';
      severity_override = 'info';
      break;
    case 'long_stay':
      backend_event = 'V4_LONG_STAY';
      alert_level = evt.level === 3 ? 'emergency' : evt.level === 2 ? 'critical' : 'warning';
      severity_override = evt.level === 3 ? 'emergency' : evt.level === 2 ? 'critical' : 'warning';
      break;
    case 'safety_ceiling':
      backend_event = 'V4_SAFETY_CEILING';
      alert_level = 'emergency';
      severity_override = 'emergency';
      break;
    default:
      return; // Unknown family event — skip
  }

  // Write alert_log
  let alert_log_id;
  try {
    const log_entry = await alert_log.create({
      title: copy.title,
      description: copy.body,
      resident: resident_info?._id,
      device_type: 'zigbee',
      alert_level,
      is_resolved: evt.type === 'all_clear',
      meta: {
        sensor_type: 'occupancy_v4',
        occupancy_group,
        room: room_label,
        event_type: evt.type,
        occupied_s: evt.occupiedS,
        silence_s: evt.silenceS,
        test_mode: evt.testMode,
        v4: true,
      },
    });
    alert_log_id = log_entry._id;
  } catch (err) {
    console.error('[occupancy-v4] alert_log write failed:', err.message);
  }

  // Push notification to family
  if (!target_user?._id) return;

  // Check mute state
  const user_model = (await import('../models/users.js')).default;
  const recipient = await user_model
    .findById(target_user._id)
    .select('notifications_enabled muted_alert_devices muted_push_devices')
    .lean();

  if (is_alert_muted(recipient, DeviceCategory.MOTION_PRESENCE)) {
    console.log(`[occupancy-v4] push skipped — alert muted for user=${target_user._id}`);
    return;
  }

  try {
    await dispatch_notification({
      backend_event,
      user_id: target_user._id,
      title: copy.title,
      body: copy.body,
      severity: severity_override,
      bypass_quiet_hours: is_critical,
      full_screen: !!evt.requiresAck,
      data: {
        occupancy_group,
        room: room_label,
        resident: resident_info?._id?.toString(),
        alert_log_id: alert_log_id?.toString(),
        event_type: evt.type,
        requires_ack: !!evt.requiresAck,
        v4: true,
      },
    });
    console.log(`[occupancy-v4] push sent: ${evt.type} → user=${target_user._id}`);
  } catch (err) {
    console.error(`[occupancy-v4] push dispatch failed: ${err.message}`);
  }
};

// ── Machine lifecycle ───────────────────────────────────────────────────────

const get_or_create_machine = async (resident_id, occupancy_group, context) => {
  const key = cache_key(resident_id, occupancy_group);
  if (machines.has(key)) return machines.get(key);

  // Load persisted state (if any)
  const saved = await room_occupancy_v4_state
    .findOne({ resident: resident_id, occupancy_group })
    .lean();

  // Load per-room config overrides
  const config_overrides = saved?.config_overrides || {};
  const test_mode = saved?.test_mode || false;
  const room_label = saved?.room_label || 'Room';

  // Build machine config
  const cfg = {
    roomId: occupancy_group,
    homeId: context.home_id || null,
    testMode: test_mode,
    ...config_overrides,
  };

  // Create the event handler with full context
  const handler_context = {
    target_user: context.target_user,
    resident_info: context.resident_info,
    occupancy_group,
    room_label,
    sm: null, // will be set after construction
  };

  const sm = new BathroomOccupancy(cfg, create_event_handler(handler_context));
  handler_context.sm = sm;

  // Restore from snapshot if available (spec 6.4)
  if (saved?.snapshot) {
    const restored = sm.restore(saved.snapshot, Date.now());
    if (restored) {
      console.log(
        `[occupancy-v4] restored state=${sm.state} for ${occupancy_group}`,
      );
    } else {
      console.warn(
        `[occupancy-v4] snapshot rejected (stale/invalid) for ${occupancy_group} — starting VACANT`,
      );
    }
  }

  machines.set(key, { sm, handler_context });
  return { sm, handler_context };
};

const persist = async (sm, resident_id, occupancy_group) => {
  if (!sm.dirty) return;
  try {
    await room_occupancy_v4_state.updateOne(
      { resident: resident_id, occupancy_group },
      {
        $set: {
          snapshot: sm.snapshot(Date.now()),
          state: sm.state,
          version: 4,
        },
      },
      { upsert: true },
    );
    sm.dirty = false;
  } catch (err) {
    console.error(`[occupancy-v4] persist failed for ${occupancy_group}:`, err.message);
  }
};

// ── Public API — called from zigbee_service.js ──────────────────────────────

/**
 * Main entry point for v4 occupancy events. Called from
 * zigbee_service.select_device_send_data when a device has sensor_role
 * 'doorway' or 'inside'.
 *
 * @param {string} sensor_role - 'doorway' | 'inside'
 * @param {Object} body - { target_user, data, device, device_info, resident_info }
 */
const handle_occupancy_v4_event = async (sensor_role, body) => {
  const { target_user, data, device_info } = body;
  let { resident_info } = body;

  if (!device_info?.occupancy_group) {
    console.warn('[occupancy-v4] event skipped — no occupancy_group on device');
    return;
  }

  // Resolve resident if not already available
  resident_info = await resolve_resident_for_device(device_info, resident_info);
  if (!resident_info) {
    console.warn('[occupancy-v4] event skipped — cannot resolve resident');
    return;
  }

  const occupancy_group = device_info.occupancy_group;
  const resident_id = resident_info._id;

  // Map sensor_role to state machine ROLES
  let role;
  if (sensor_role === 'doorway') {
    role = ROLES.DOORWAY;
  } else if (sensor_role === 'inside') {
    role = ROLES.INSIDE;
  } else {
    console.warn(`[occupancy-v4] unknown sensor_role="${sensor_role}" — skipped`);
    return;
  }

  // Get or create machine
  const { sm, handler_context } = await get_or_create_machine(
    resident_id,
    occupancy_group,
    {
      target_user,
      resident_info,
      home_id: device_info.home?.toString() || null,
    },
  );

  // Update context (target_user may change between requests if multiple
  // family members are listening, but the machine is per-room)
  handler_context.target_user = target_user;
  handler_context.resident_info = resident_info;

  // Feed the event to the state machine.
  // Use Date.now() as the Pi timestamp — the current backend doesn't
  // forward Pi timestamps in the HTTP body, so server arrival time is the
  // best available.
  const now_ms = Date.now();
  const value = data.occupancy === true;
  const retained = data.retained === true;

  sm.onSensor(role, value, now_ms, { retained });
  sm.tick(now_ms);

  await persist(sm, resident_id, occupancy_group);
};

/**
 * Handle sensor availability changes for v4 rooms.
 * Called when a v4 sensor goes online/offline.
 */
const handle_occupancy_v4_availability = async (
  sensor_role,
  online,
  resident_id,
  occupancy_group,
  context,
) => {
  const key = cache_key(resident_id, occupancy_group);
  if (!machines.has(key)) return; // no active machine for this room

  const { sm } = machines.get(key);
  const role = sensor_role === 'doorway' ? ROLES.DOORWAY : ROLES.INSIDE;
  const now_ms = Date.now();

  sm.onAvailability(role, online, now_ms);
  sm.tick(now_ms);
  await persist(sm, resident_id, occupancy_group);
};

/**
 * Tick all active v4 machines. Called from the existing 30s cron in
 * occupancy_alert_checker.js.
 *
 * The state machine's tick() drives the checking/alert/long-stay/safety-
 * ceiling timers — it MUST be called even when there are no sensor events.
 */
const tick_all_v4_machines = async () => {
  const now = Date.now();
  for (const [key, { sm }] of machines) {
    try {
      sm.tick(now);
      if (sm.dirty) {
        const [resident_id, occupancy_group] = key.split(':');
        await persist(sm, resident_id, occupancy_group);
      }
    } catch (err) {
      console.error(`[occupancy-v4] tick failed for ${key}:`, err.message);
    }
  }
};

/**
 * Bootstrap: restore v4 machines from the database for rooms that were
 * not VACANT when the server last shut down. Call once at startup.
 */
const restore_v4_machines = async () => {
  try {
    const active_rooms = await room_occupancy_v4_state
      .find({ state: { $ne: 'VACANT' } })
      .lean();

    for (const room of active_rooms) {
      try {
        // We need target_user and resident_info for the event handler.
        const resident_info = await resident_model
          .findById(room.resident)
          .lean();
        if (!resident_info) continue;

        // Resolve user through resident.creator
        const user_model = (await import('../models/users.js')).default;
        const target_user = await user_model
          .findById(resident_info.creator)
          .select('_id')
          .lean();
        if (!target_user) continue;

        await get_or_create_machine(
          room.resident,
          room.occupancy_group,
          {
            target_user,
            resident_info,
            home_id: resident_info.home?.toString() || null,
          },
        );
        console.log(
          `[occupancy-v4] boot-restored ${room.occupancy_group} state=${room.state}`,
        );
      } catch (err) {
        console.error(
          `[occupancy-v4] boot-restore failed for ${room.occupancy_group}:`,
          err.message,
        );
      }
    }
    console.log(`[occupancy-v4] restored ${active_rooms.length} active room(s)`);
  } catch (err) {
    console.error('[occupancy-v4] restore_v4_machines failed:', err.message);
  }
};

/**
 * Family acknowledgement — clears alert repeats for everyone (spec 5.4).
 * Returns true if the room was in ALERTED state.
 */
const acknowledge_v4_alert = async (resident_id, occupancy_group, user_id) => {
  const key = cache_key(resident_id, occupancy_group);
  if (!machines.has(key)) return false;

  const { sm } = machines.get(key);
  const ok = sm.acknowledge(Date.now(), user_id);

  if (ok) {
    await persist(sm, resident_id, occupancy_group);
    console.log(
      `[occupancy-v4] alert acknowledged by user=${user_id} for ${occupancy_group}`,
    );
  }
  return ok;
};

/**
 * Set Away mode for a v4 room (spec 6.8).
 */
const set_v4_away = async (resident_id, occupancy_group, away, context) => {
  const key = cache_key(resident_id, occupancy_group);
  let entry;

  if (machines.has(key)) {
    entry = machines.get(key);
  } else {
    entry = await get_or_create_machine(resident_id, occupancy_group, context);
  }

  entry.sm.setAway(away, Date.now());
  await persist(entry.sm, resident_id, occupancy_group);
  return true;
};

/**
 * Get the current v4 state for a room (for API responses).
 */
const get_v4_room_state = async (resident_id, occupancy_group) => {
  const key = cache_key(resident_id, occupancy_group);

  if (machines.has(key)) {
    const { sm } = machines.get(key);
    return {
      state: sm.state,
      occupied_since: sm.enteredAt ? new Date(sm.enteredAt).toISOString() : null,
      version: 4,
      occupancy_group,
    };
  }

  // Fallback to DB
  const saved = await room_occupancy_v4_state
    .findOne({ resident: resident_id, occupancy_group })
    .lean();

  if (!saved) return null;

  return {
    state: saved.state,
    occupied_since: saved.snapshot?.enteredAt
      ? new Date(saved.snapshot.enteredAt).toISOString()
      : null,
    version: 4,
    occupancy_group,
  };
};

export {
  handle_occupancy_v4_event,
  handle_occupancy_v4_availability,
  tick_all_v4_machines,
  restore_v4_machines,
  acknowledge_v4_alert,
  set_v4_away,
  get_v4_room_state,
  STATES as V4_STATES,
};

export default {
  handle_occupancy_v4_event,
  handle_occupancy_v4_availability,
  tick_all_v4_machines,
  restore_v4_machines,
  acknowledge_v4_alert,
  set_v4_away,
  get_v4_room_state,
};
