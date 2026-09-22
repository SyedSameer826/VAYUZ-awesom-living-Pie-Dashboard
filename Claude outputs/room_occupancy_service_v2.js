// ============================================================================
// Room Occupancy Service v2.2 — wraps bathroom_watch.js (pure state machine)
//
// Devices (Z2M friendly names configurable per group):
//   bath_doorway : SNZB-03P curtain sensor across the doorway  (occupancy)
//   bath_inside  : SNZB-03P inside, aimed at the floor         (occupancy)
//   bath_door    : SNZB-04P door contact                       (contact=true → closed)
//
// States: EMPTY → TENTATIVE → OCCUPIED → EXIT_PENDING → EMPTY
//                  OCCUPIED → CHECKING (chime, if sounder fitted) → ALERTED
//
// Socket events emitted to the app:
//   bathroom_update  — real-time push on every state/motion change
//   bathroom_status  — one-shot response to get_bathroom_status
//
// Push notifications are for ALERTS ONLY (escalate, activity_after_alert).
// No ROOM_OCCUPIED / ROOM_VACANT push. State shown in app via socket only.
//
// Wording: "someone" and "prolonged inactivity in the bathroom". Never "fall".
// ============================================================================

import room_occupancy_state from '../models/room_occupancy_state.js';
import socket_service from '../utils/socket.js';
import { dispatch_notification } from './notification_service.js';
import resident_model from '../models/resident.js';

// ── Import the pure state machine ───────────────────────────────────────────
import { createRequire } from 'module';
const require_cjs = createRequire(import.meta.url);
const {
  DEFAULTS: BW_DEFAULTS,
  BathroomWatch,
  EMPTY,
  TENTATIVE,
  OCCUPIED,
  EXIT_PENDING,
  CHECKING,
  ALERTED,
  validate: validate_bw_config,
} = require_cjs('./bathroom_watch.cjs');

// ── In-memory instances keyed by occupancy_group ────────────────────────────
// Each group gets one BathroomWatch + metadata.  The tick loop drives all of
// them every 2 s.
const _instances = {};   // { [occupancy_group]: { watch, resident_id, target_user, room_label, group, last_persisted, visit_count, visit_count_date, last_entered_wall, last_exit_wall, last_seen_wall } }

// ── Config per group (could come from DB later; hardcoded for pilot) ────────
const GROUP_CONFIG = {
  bathroom_1: {
    ...BW_DEFAULTS,
    sounder_name: '',          // no sounder at pilot home
    silence_s_day: 900,        // 15 min
    silence_s_night: 600,      // 10 min
    night_start: '22:00',
    night_end: '06:00',
    exit_confirm_s: 120,
    tentative_confirm_s: 60,
    door_swing_s: 2,
    door_open_starts_tentative: true,
    long_visit_s: 3600,
    alert_repeat_s: 300,
  },
};

function get_group_config(occupancy_group) {
  const base = GROUP_CONFIG[occupancy_group] || { ...BW_DEFAULTS, sounder_name: '' };
  return base;
}

// ── Resident resolution (same as v1 — Zigbee devices map to a home) ────────
const resolve_resident = async (device_info, resident_info) => {
  if (resident_info?._id) return resident_info;
  if (!device_info?.home) return null;
  const found = await resident_model.findOne({ home: device_info.home }).lean();
  return found || null;
};

// ── Build the BathroomData payload the Flutter app expects ──────────────────
// Schema: { occupancy, duration_min, duration, visit_count, last_entered,
//           last_exit, last_seen, alert_threshold, alert_active }

const build_bathroom_data = (inst) => {
  const watch = inst.watch;
  const now_mono = watch.clock();

  // occupancy = true when the room is genuinely occupied (confirmed entry or
  // in the process of exiting / being checked / alerted).  TENTATIVE is NOT
  // occupied — the person hasn't been confirmed inside yet.
  const is_occupied = [OCCUPIED, EXIT_PENDING, CHECKING, ALERTED].includes(watch.state);

  // Duration of current visit
  let duration_min = 0;
  let duration = '0m';
  if (is_occupied && watch.entered_at !== null) {
    const elapsed_s = now_mono - watch.entered_at;
    duration_min = Math.round(elapsed_s / 6) / 10;   // 1 decimal place
    const mins = Math.floor(elapsed_s / 60);
    if (mins >= 60) {
      duration = `${Math.floor(mins / 60)}h ${mins % 60}m`;
    } else {
      duration = `${mins}m`;
    }
  }

  // Day/night alert threshold in minutes
  const threshold_s = watch.threshold();
  const alert_threshold = Math.floor(threshold_s / 60);

  // Alert is active when we're chiming or already escalated
  const alert_active = [CHECKING, ALERTED].includes(watch.state);

  return {
    occupancy: is_occupied,
    duration_min,
    duration,
    visit_count: inst.visit_count || 0,
    last_entered: inst.last_entered_wall ? inst.last_entered_wall.toISOString() : null,
    last_exit: inst.last_exit_wall ? inst.last_exit_wall.toISOString() : null,
    last_seen: inst.last_seen_wall ? inst.last_seen_wall.toISOString() : null,
    alert_threshold,
    alert_active,
  };
};

// ── Helper: today's date string (YYYY-MM-DD) for visit_count reset ──────────
const today_str = () => new Date().toISOString().slice(0, 10);

// ── Emit socket events (app shows state in real time, no push) ──────────────
const emit_occupancy_update = (target_user, group, inst) => {
  if (!target_user?._id) {
    console.log(`[OCC][SOCKET] SKIP — no target_user._id`);
    return;
  }

  const bathroom_data = build_bathroom_data(inst);

  console.log(
    `[OCC][SOCKET] EMIT bathroom_update → user=${target_user._id} | occupancy=${bathroom_data.occupancy} | state=${inst.watch.state} | group=${group}`,
  );

  // Primary event — the Flutter app listens for this
  socket_service.send_to_user(
    target_user._id.toString(),
    'bathroom_update',
    bathroom_data,
  );

  // Also emit the internal event for any dashboard/debug consumers
  socket_service.send_to_user(
    target_user._id.toString(),
    'room_occupancy_update',
    {
      occupancy_group: group,
      state: inst.watch.state,
      inside_active: inst.watch.inside_active,
      door_closed: inst.watch.door_closed,
      entered_at: inst.watch.entered_at,
      max_silence: inst.watch.max_silence,
    },
  );
};

// ── Handle get_bathroom_status (snapshot request from app) ──────────────────
const handle_get_bathroom_status = (user_id, payload) => {
  console.log(
    `[OCC][SNAPSHOT] get_bathroom_status from user=${user_id} | payload=${JSON.stringify(payload)}`,
  );

  // Find the matching instance — the app sends device_name but we key by
  // occupancy_group.  For the pilot there's only bathroom_1, so iterate.
  for (const key of Object.keys(_instances)) {
    const inst = _instances[key];
    if (!inst.target_user?._id) continue;
    if (inst.target_user._id.toString() !== user_id.toString()) continue;

    const bathroom_data = build_bathroom_data(inst);

    console.log(
      `[OCC][SNAPSHOT] EMIT bathroom_status → user=${user_id} | group=${key} | occupancy=${bathroom_data.occupancy}`,
    );

    socket_service.send_to_user(
      user_id.toString(),
      'bathroom_status',
      bathroom_data,
    );
    return;
  }

  // No active instance — respond with an empty/vacant snapshot
  console.log(
    `[OCC][SNAPSHOT] no active instance for user=${user_id}, sending vacant`,
  );
  socket_service.send_to_user(
    user_id.toString(),
    'bathroom_status',
    {
      occupancy: false,
      duration_min: 0,
      duration: '0m',
      visit_count: 0,
      last_entered: null,
      last_exit: null,
      last_seen: null,
      alert_threshold: 15,   // default day threshold
      alert_active: false,
    },
  );
};

// ── Persist state to MongoDB ────────────────────────────────────────────────
const persist_state = async (resident_id, occupancy_group, inst) => {
  const watch = inst.watch;
  const snap = watch.snapshot();
  const now = new Date();
  await room_occupancy_state.findOneAndUpdate(
    { resident: resident_id, occupancy_group },
    {
      $set: {
        state: watch.state,
        bw_snapshot: snap,
        last_updated: now,
        occupied_since: watch.entered_at !== null
          ? new Date(watch.wall() * 1000 - (watch.clock() - watch.entered_at) * 1000)
          : null,
        // Persist visit metadata so it survives restarts
        visit_count: inst.visit_count || 0,
        visit_count_date: inst.visit_count_date || today_str(),
        last_entered_wall: inst.last_entered_wall || null,
        last_exit_wall: inst.last_exit_wall || null,
        last_seen_wall: inst.last_seen_wall || null,
      },
      $setOnInsert: { resident: resident_id, occupancy_group },
    },
    { upsert: true, new: true },
  );
};

// ── Restore state from MongoDB on first event ───────────────────────────────
const try_restore = async (watch, inst, resident_id, occupancy_group) => {
  try {
    const doc = await room_occupancy_state
      .findOne({ resident: resident_id, occupancy_group })
      .lean();
    if (doc?.bw_snapshot) {
      if (watch.restore(doc.bw_snapshot)) {
        console.log(
          `[OCC][RESTORE] restored ${occupancy_group} → state=${watch.state}`,
        );
        // Restore visit metadata
        const td = today_str();
        if (doc.visit_count_date === td) {
          inst.visit_count = doc.visit_count || 0;
        } else {
          inst.visit_count = 0;   // new day, reset count
        }
        inst.visit_count_date = td;
        inst.last_entered_wall = doc.last_entered_wall ? new Date(doc.last_entered_wall) : null;
        inst.last_exit_wall = doc.last_exit_wall ? new Date(doc.last_exit_wall) : null;
        inst.last_seen_wall = doc.last_seen_wall ? new Date(doc.last_seen_wall) : null;
        return true;
      }
      console.log(
        `[OCC][RESTORE] snapshot too stale for ${occupancy_group}, starting fresh`,
      );
    }
  } catch (err) {
    console.error(`[OCC][RESTORE] failed for ${occupancy_group}:`, err.message);
  }
  return false;
};

// ── Get or create a BathroomWatch instance for an occupancy group ───────────
const get_or_create_instance = async (occupancy_group, resident_id, target_user, room_label) => {
  if (_instances[occupancy_group]) {
    // Update mutable context (target_user may resolve later)
    const inst = _instances[occupancy_group];
    if (target_user?._id) inst.target_user = target_user;
    if (room_label) inst.room_label = room_label;
    return inst;
  }

  const cfg = get_group_config(occupancy_group);
  validate_bw_config(cfg);

  const events_buffer = [];   // filled by emit callback, flushed after each event

  const watch = new BathroomWatch(
    cfg,
    (rec) => events_buffer.push(rec),
    null,   // no sounder at pilot
  );

  const inst = {
    watch,
    events_buffer,
    resident_id,
    target_user,
    room_label: room_label || 'Bathroom',
    group: occupancy_group,
    last_persisted: Date.now(),
    // Visit metadata for Flutter app payload
    visit_count: 0,
    visit_count_date: today_str(),
    last_entered_wall: null,
    last_exit_wall: null,
    last_seen_wall: null,
  };

  await try_restore(watch, inst, resident_id, occupancy_group);

  _instances[occupancy_group] = inst;

  console.log(
    `[OCC][INIT] instance created for ${occupancy_group} | state=${watch.state} | resident=${resident_id}`,
  );
  return inst;
};

// ── Process emitted events (alerts, logging, visit tracking) ────────────────
const process_events = async (inst) => {
  const { events_buffer, target_user, room_label, group, watch } = inst;

  while (events_buffer.length > 0) {
    const rec = events_buffer.shift();
    console.log(`[OCC][EVENT] ${group} | ${rec.event} | state=${rec.state} | ${JSON.stringify(rec)}`);

    // ── Track visit metadata from events ────────────────────────────
    const now_wall = new Date();

    if (rec.event === 'entry') {
      // Reset visit_count if it's a new day
      const td = today_str();
      if (inst.visit_count_date !== td) {
        inst.visit_count = 0;
        inst.visit_count_date = td;
      }
      inst.visit_count += 1;
      inst.last_entered_wall = now_wall;
      inst.last_seen_wall = now_wall;
    }

    if (rec.event === 'exit') {
      inst.last_exit_wall = now_wall;
      inst.last_seen_wall = now_wall;
    }

    // Inside motion → update last_seen
    if (
      rec.event === 'check_resolved' ||
      rec.event === 'exit_cancelled' ||
      rec.event === 'activity_after_alert'
    ) {
      inst.last_seen_wall = now_wall;
    }

    // ── Socket update on every state-changing event ──────────────────
    emit_occupancy_update(target_user, group, inst);

    // ── ESCALATE → push alert to family ──────────────────────────────
    if (rec.event === 'escalate' && target_user?._id) {
      const location = room_label || 'Bathroom';
      console.log(
        `[OCC][ALERT] DISPATCH ESCALATE → user=${target_user._id} | room=${location} | silence=${rec.silence_s}s`,
      );
      dispatch_notification({
        backend_event: 'BATHROOM_INACTIVITY_ALERT',
        user_id: target_user._id,
        template_vars: {
          location,
          subject: 'someone',
          reason: 'prolonged inactivity in the bathroom',
          silence_minutes: Math.floor(rec.silence_s / 60),
        },
        data: {
          occupancy_group: group,
          resident: inst.resident_id?.toString(),
          silence_s: rec.silence_s,
          night: rec.night,
          sensors_offline: rec.sensors_offline,
        },
      }).catch((err) =>
        console.error('[OCC][ALERT] ESCALATE dispatch FAILED:', err.message),
      );
    }

    // ── ALERT_REPEAT → repeat alert every 5 min ─────────────────────
    if (rec.event === 'alert_repeat' && target_user?._id) {
      console.log(
        `[OCC][ALERT] DISPATCH ALERT_REPEAT → user=${target_user._id} | alerted_for=${rec.alerted_for_s}s`,
      );
      dispatch_notification({
        backend_event: 'BATHROOM_INACTIVITY_REPEAT',
        user_id: target_user._id,
        template_vars: {
          location: room_label || 'Bathroom',
          subject: 'someone',
          alerted_for_minutes: Math.floor(rec.alerted_for_s / 60),
        },
        data: {
          occupancy_group: group,
          resident: inst.resident_id?.toString(),
        },
      }).catch((err) =>
        console.error('[OCC][ALERT] ALERT_REPEAT dispatch FAILED:', err.message),
      );
    }

    // ── ACTIVITY_AFTER_ALERT → "Movement detected again" follow-up ──
    if (rec.event === 'activity_after_alert' && target_user?._id) {
      console.log(
        `[OCC][ALERT] DISPATCH ACTIVITY_AFTER_ALERT → user=${target_user._id}`,
      );
      dispatch_notification({
        backend_event: 'BATHROOM_MOVEMENT_AFTER_ALERT',
        user_id: target_user._id,
        template_vars: {
          location: room_label || 'Bathroom',
          message: 'Movement detected again in the bathroom',
        },
        data: {
          occupancy_group: group,
          resident: inst.resident_id?.toString(),
        },
      }).catch((err) =>
        console.error('[OCC][ALERT] ACTIVITY_AFTER_ALERT dispatch FAILED:', err.message),
      );
    }

    // ── ENTRY_UNCONFIRMED → internal log only, NOT sent to family ───
    if (rec.event === 'entry_unconfirmed') {
      console.log(
        `[OCC][INTERNAL] entry_unconfirmed for ${group} — tentative_s=${rec.tentative_s} (internal log only, not sent to family)`,
      );
    }

    // ── EXIT with max_silence_s → log for threshold calibration ─────
    if (rec.event === 'exit' && rec.max_silence_s !== undefined) {
      console.log(
        `[OCC][CALIBRATION] exit from ${group} — max_silence_s=${rec.max_silence_s} (logged for 2-week threshold tuning)`,
      );
    }
  }

  // ── Persist to DB (throttled: at most every 5 s, or on state change) ──
  const now_ms = Date.now();
  if (inst.watch.dirty || now_ms - inst.last_persisted > 5000) {
    await persist_state(inst.resident_id, inst.group, inst);
    inst.watch.dirty = false;
    inst.last_persisted = now_ms;
  }
};

// ── Map sensor_role → BathroomWatch sensor kind ─────────────────────────────
const ROLE_TO_KIND = {
  threshold_motion: 'doorway',   // curtain/doorway PIR
  room_motion: 'inside',         // inside PIR (master)
  occupancy_door: 'door',        // door contact
};

const ROLE_TO_FIELD = {
  threshold_motion: 'occupancy',
  room_motion: 'occupancy',
  occupancy_door: 'contact',
};

// ── Main entry point ────────────────────────────────────────────────────────

const handle_occupancy_event = async (sensor_role, body) => {
  const { target_user, data, device, device_info, resident_info } = body;

  console.log(
    `[OCC][ENTRY] ──────────── device=${device} | role=${sensor_role} | group=${device_info?.occupancy_group} | data=${JSON.stringify(data)}`,
  );

  if (!device_info?.occupancy_group) {
    console.log(`[OCC][ENTRY] SKIP — no occupancy_group on device_info`);
    return;
  }

  const resolved_resident = await resolve_resident(device_info, resident_info);
  if (!resolved_resident?._id) {
    console.warn(
      `[OCC][ENTRY] NO RESIDENT — device=${device} | home=${device_info.home} — skipping`,
    );
    return;
  }

  const occupancy_group = device_info.occupancy_group;
  const room_label = device_info.room || 'Bathroom';

  const inst = await get_or_create_instance(
    occupancy_group,
    resolved_resident._id,
    target_user,
    room_label,
  );

  // ── Update last_seen on any inside motion ─────────────────────────
  if (sensor_role === 'room_motion' && data?.occupancy === true) {
    inst.last_seen_wall = new Date();
  }

  // ── Translate sensor event to BathroomWatch input ─────────────────
  const kind = ROLE_TO_KIND[sensor_role];
  const field = ROLE_TO_FIELD[sensor_role];
  if (!kind || !(field in data)) {
    console.warn(`[OCC][ENTRY] unknown role=${sensor_role} or missing field=${field}`);
    return;
  }

  let value;
  if (kind === 'door') {
    // contact=true → closed → BathroomWatch door value=true (closed)
    // contact=false → open → BathroomWatch door value=false (open)
    value = Boolean(data[field]);
  } else {
    // occupancy=true → PIR active
    value = Boolean(data[field]);
  }

  console.log(
    `[OCC][SENSOR] ${kind}=${value} | prev=${inst.watch.prev[kind]} | bw_state=${inst.watch.state}`,
  );

  inst.watch.on_sensor(kind, value);

  // ── Process any events the state machine emitted ──────────────────
  await process_events(inst);

  console.log(
    `[OCC][ENTRY] ──────────── done for ${device} | new_state=${inst.watch.state}`,
  );
};

// ── Tick loop — drives time-based transitions (exit confirm, silence, etc) ──
let _tick_interval = null;

const start_tick_loop = () => {
  if (_tick_interval) return;
  _tick_interval = setInterval(async () => {
    for (const key of Object.keys(_instances)) {
      const inst = _instances[key];
      try {
        inst.watch.tick();
        await process_events(inst);
      } catch (err) {
        console.error(`[OCC][TICK] error for ${key}:`, err.message);
      }
    }
  }, 2000);   // tick_s = 2
  console.log('[OCC][TICK] tick loop started (every 2 s)');
};

const stop_tick_loop = () => {
  if (_tick_interval) {
    clearInterval(_tick_interval);
    _tick_interval = null;
    console.log('[OCC][TICK] tick loop stopped');
  }
};

// ── Availability handler (sensor online/offline from Z2M) ───────────────────
const handle_availability_event = async (occupancy_group, kind, online) => {
  const inst = _instances[occupancy_group];
  if (!inst) return;
  inst.watch.on_availability(kind, online);
  await process_events(inst);
};

// ── Public API ──────────────────────────────────────────────────────────────

export {
  handle_occupancy_event,
  handle_availability_event,
  handle_get_bathroom_status,
  start_tick_loop,
  stop_tick_loop,
};
export default {
  handle_occupancy_event,
  handle_availability_event,
  handle_get_bathroom_status,
  start_tick_loop,
  stop_tick_loop,
};
