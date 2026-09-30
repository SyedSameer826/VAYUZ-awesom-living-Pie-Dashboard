// ============================================================================
// Occupancy Alert Checker — cron job for room occupancy detection alerts.
//
// Runs every 30 seconds. Handles:
//
//   1. Entry Pending timeout → revert to vacant
//   2. Exit Pending silence window → confirm vacant or revert to occupied
//      After 120s silence (no master=true during exit_pending), checks
//      exit_door_opened: true → vacant + ROOM_VACANT notification,
//      false → occupied (curtain false-trigger, door never opened)
//   3. Stillness Alert (Req 2) — master=false + no sensor activity → P0
//   4. Long Stay Alert (Req 3) — 3 escalating levels + emergency repeat
//      Default: [30, 35, 40] min, repeat every 5 min until acknowledged
//      Test:    [3, 3.5, 4] min, repeat every 30s
//   5. Safety Ceiling — stuck occupied with zero signals for hours
// ============================================================================

import cron from 'node-cron';
import room_occupancy_state from '../models/room_occupancy_state.js';
import room_occupancy_settings from '../models/room_occupancy_settings.js';
import user from '../models/users.js';
import resident from '../models/resident.js';
import alert_log from '../models/alert_log.js';
import socket_service from '../utils/socket.js';
import { dispatch_notification, is_alert_muted } from './notification_service.js';
import { DeviceCategory } from '../constants/notification_events.js';
import hub_service from './hub_service.js';
import { get_device_details } from './device_service.js';
import zigbee_logs_service from './health_logs.js';

// ── bathroom_update emit helper (mirrors room_occupancy_service logic) ──────
const emit_bathroom_update = async (user_id_str, occupancy_group, is_occupied) => {
  try {
    const motion_device = await get_device_details({
      occupancy_group,
      sensor_role: 'room_motion',
      status: 'active',
    });
    if (!motion_device) return;

    const device_name = motion_device.id || motion_device.zigbee_id;
    if (!device_name) return;

    const bathroom_data = await zigbee_logs_service.get_bathroom_data(device_name);
    bathroom_data.occupancy = is_occupied;

    console.log(
      `[occupancy-cron] socket emit bathroom_update → ` +
        `user=${user_id_str} occupancy=${is_occupied}`,
    );
    socket_service.send_to_user(user_id_str, 'bathroom_update', bathroom_data);
  } catch (err) {
    console.error('[occupancy-cron] bathroom_update emit failed:', err.message);
  }
};

// ── IST time-window helpers ─────────────────────────────────────────────────
const get_current_ist_time_str = () => {
  const now = new Date();
  const ist_ms = now.getTime() + (5 * 60 + 30) * 60 * 1000;
  const ist = new Date(ist_ms);
  const h = String(ist.getUTCHours()).padStart(2, '0');
  const m = String(ist.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
};

const is_within_window = (current, from, to) => {
  if (from <= to) return current >= from && current <= to;
  return current >= from || current <= to;
};

const format_duration = (minutes) => {
  if (minutes < 1) return 'less than 1 min';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
};

// ── Per-level notification copy ─────────────────────────────────────────────
const long_stay_levels = [
  {
    level: 1,
    severity: 'warning',
    alert_level: 'warning',
    title: 'Long stay alert',
    body: 'Someone has been in the {location} for over {threshold} minutes.',
  },
  {
    level: 2,
    severity: 'critical',
    alert_level: 'critical',
    title: 'Extended stay — please check in',
    body: 'Someone has been in the {location} for over {threshold} minutes. Please check in.',
  },
  {
    level: 3,
    severity: 'emergency',
    alert_level: 'emergency',
    title: 'Urgent — extended stay',
    body: 'Someone has been in the {location} for over {threshold} minutes. Immediate attention recommended.',
    is_p0_fullscreen: true,
    requires_acknowledgement: true,
  },
];

// ── Test mode flag ─────────────────────────────────────────────────────────
// Set to true for quick walk-testing, false for production timers.
// Must match the flag in room_occupancy_service.js.
const test_mode_enabled = true;

// ── Test mode thresholds (minutes) ─────────────────────────────────────────
// When test_mode is enabled, these override configured thresholds.
const test_long_stay_thresholds = [3, 3.5, 4]; // 3 min, +30s, +30s
const test_emergency_repeat_min = 0.5; // 30s repeat
const test_stillness_threshold_min = 0.5; // 30s for test

// ── Reset constants (must match room_occupancy_service.js) ────────────────
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

const all_alerts_reset = {
  stillness_alert_sent: false,
  stillness_alert_sent_at: null,
  stillness_alert_log_id: null,
  long_stay_level_reached: 0,
  long_stay_level_1_time: null,
  long_stay_level_1_log_id: null,
  long_stay_level_2_time: null,
  long_stay_level_2_log_id: null,
  long_stay_level_3_time: null,
  long_stay_level_3_log_id: null,
  long_stay_last_emergency_repeat_at: null,
  safety_ceiling_alert_sent: false,
  safety_ceiling_alert_time: null,
  safety_ceiling_alert_log_id: null,
};

// ── Helper: check if latest alert_log was acknowledged ────────────────────
const is_latest_emergency_acknowledged = async (log_id) => {
  if (!log_id) return false;
  const log_entry = await alert_log.findById(log_id).select('is_resolved').lean();
  return log_entry?.is_resolved === true;
};

// ── Main cron ───────────────────────────────────────────────────────────────

const start_occupancy_alert_checker = () => {
  cron.schedule('*/30 * * * * *', async () => {
    try {
      // Hub offline — no fresh sensor data, skip to avoid false alerts.
      const offline_residents = await hub_service.get_offline_resident_ids();
      const now = Date.now();

      // Diagnostic: log occupied rooms count and offline residents each tick
      const occupied_count = await room_occupancy_state.countDocuments({ state: 'occupied' });
      if (occupied_count > 0) {
        console.log(
          `[occupancy-cron] tick: ${occupied_count} occupied room(s), ` +
            `offline_residents: [${[...offline_residents].join(', ')}]`,
        );
      }

      // ── 1. ENTRY PENDING timeout ──────────────────────────────────────
      const entry_pending_rooms = await room_occupancy_state
        .find({ state: 'entry_pending', entry_started_at: { $ne: null } })
        .lean();

      for (const rs of entry_pending_rooms) {
        try {
          if (offline_residents.has(String(rs.resident))) continue;

          const settings = await room_occupancy_settings
            .findOne({
              resident: rs.resident,
              occupancy_group: rs.occupancy_group,
              is_active: true,
            })
            .lean();

          const entry_window_sec = settings?.entry_window_sec ?? 60;
          const elapsed_sec = (now - new Date(rs.entry_started_at).getTime()) / 1000;

          if (elapsed_sec > entry_window_sec) {
            await room_occupancy_state.updateOne(
              { _id: rs._id },
              { $set: { state: 'vacant', master_is_active: false, ...entry_reset } },
              { strict: false },
            );

            // Emit socket update
            const resident_info = await resident.findById(rs.resident).lean();
            if (resident_info?.creator) {
              const user_info = await user.findById(resident_info.creator).select('_id').lean();
              if (user_info?._id) {
                const user_id_str = user_info._id.toString();
                socket_service.send_to_user(user_id_str, 'room_occupancy_update', {
                  occupancy_group: rs.occupancy_group,
                  resident: rs.resident,
                  state: 'vacant',
                  room_label: rs.room_label,
                });

                // bathroom_update (backward-compat for legacy bathroom screen)
                await emit_bathroom_update(user_id_str, rs.occupancy_group, false);
              }
            }

            console.log(
              `[occupancy-cron] ${rs.occupancy_group} entry_pending expired ` +
                `(${elapsed_sec.toFixed(0)}s > ${entry_window_sec}s) → vacant`,
            );
          }
        } catch (err) {
          console.error(
            `[occupancy-cron] entry timeout error for ${rs.occupancy_group}:`,
            err.message,
          );
        }
      }

      // ── 2. EXIT PENDING: silence window → vacant or back to occupied ──
      // After curtain=true starts exit_pending, the service's silence window
      // runs for exit_silence_sec (120s). If master=true fires during that
      // window, the service cancels exit back to occupied. If the silence
      // window completes (no master=true), the cron confirms the exit here:
      //   exit_door_opened = true  → vacant (door opened during this stay)
      //   exit_door_opened = false → occupied (curtain false-trigger)
      const exit_pending_rooms = await room_occupancy_state.find({ state: 'exit_pending' }).lean();

      for (const rs of exit_pending_rooms) {
        try {
          // Do NOT skip exit_pending rooms when hub is offline. The exit
          // silence window is purely time-based — all needed data
          // (exit_silence_start_at, exit_door_opened) was already written
          // by live sensor events that triggered the exit. Skipping here
          // causes rooms to stay stuck in exit_pending forever.
          if (offline_residents.has(String(rs.resident))) {
            console.log(
              `[occupancy-cron] ${rs.occupancy_group} hub offline but ` +
                `exit_pending — proceeding with silence window check`,
            );
          }

          const settings = await room_occupancy_settings
            .findOne({
              resident: rs.resident,
              occupancy_group: rs.occupancy_group,
              is_active: true,
            })
            .lean();

          const exit_silence_sec = settings?.exit_silence_sec ?? 120;

          if (rs.exit_silence_start_at) {
            const silence_elapsed =
              (now - new Date(rs.exit_silence_start_at).getTime()) / 1000;

            if (silence_elapsed > exit_silence_sec) {
              if (rs.exit_door_opened) {
                // Door opened at some point during this stay → confirmed exit.
                await room_occupancy_state.updateOne(
                  { _id: rs._id },
                  {
                    $set: {
                      state: 'vacant',
                      occupied_since: null,
                      exit_door_opened: false,
                      ...exit_reset,
                      ...all_alerts_reset,
                    },
                  },
                  { strict: false },
                );

                const resident_info = await resident.findById(rs.resident).lean();
                if (resident_info?.creator) {
                  const user_info = await user
                    .findById(resident_info.creator)
                    .select('_id notifications_enabled muted_alert_devices')
                    .lean();
                  if (user_info?._id) {
                    const user_id_str = user_info._id.toString();

                    // room_occupancy_update (raw state)
                    socket_service.send_to_user(user_id_str, 'room_occupancy_update', {
                      occupancy_group: rs.occupancy_group,
                      resident: rs.resident,
                      state: 'vacant',
                      room_label: rs.room_label,
                    });

                    // room_state_update (translated for app UI)
                    socket_service.send_to_user(user_id_str, 'room_state_update', {
                      room: rs.room_label || 'Room',
                      resident: rs.resident,
                      state: 'empty',
                      occupancy: false,
                      motion_active: false,
                      occupied_since: null,
                      occupancy_group: rs.occupancy_group,
                    });

                    // bathroom_update (backward-compat for legacy bathroom screen)
                    await emit_bathroom_update(user_id_str, rs.occupancy_group, false);

                    // ROOM_VACANT push notification
                    await dispatch_notification({
                      backend_event: 'ROOM_VACANT',
                      user_id: user_info._id,
                      template_vars: { location: rs.room_label || 'Room' },
                      data: {
                        room: rs.room_label || 'Room',
                        resident: rs.resident.toString(),
                        occupancy_group: rs.occupancy_group,
                      },
                    }).catch((err) =>
                      console.error(
                        '[occupancy-cron] ROOM_VACANT dispatch failed:',
                        err.message,
                      ),
                    );
                  }
                }

                console.log(
                  `[occupancy-cron] ${rs.occupancy_group} exit silence complete ` +
                    `(${silence_elapsed.toFixed(0)}s > ${exit_silence_sec}s) + ` +
                    `exit_door_opened=true → vacant`,
                );
              } else {
                // Door never opened during this entire stay → not a real exit.
                // Curtain was a false trigger.
                await room_occupancy_state.updateOne(
                  { _id: rs._id },
                  {
                    $set: {
                      state: 'occupied',
                      ...exit_reset,
                    },
                  },
                  { strict: false },
                );

                const resident_info = await resident.findById(rs.resident).lean();
                if (resident_info?.creator) {
                  const user_info = await user
                    .findById(resident_info.creator)
                    .select('_id')
                    .lean();
                  if (user_info?._id) {
                    socket_service.send_to_user(
                      user_info._id.toString(),
                      'room_occupancy_update',
                      {
                        occupancy_group: rs.occupancy_group,
                        resident: rs.resident,
                        state: 'occupied',
                        occupied_since: rs.occupied_since,
                        room_label: rs.room_label,
                      },
                    );
                  }
                }

                console.log(
                  `[occupancy-cron] ${rs.occupancy_group} exit silence complete ` +
                    `(${silence_elapsed.toFixed(0)}s > ${exit_silence_sec}s) + ` +
                    `exit_door_opened=false → back to occupied (false trigger)`,
                );
              }
            }
          }
        } catch (err) {
          console.error(
            `[occupancy-cron] exit check error for ${rs.occupancy_group}:`,
            err.message,
          );
        }
      }

      // ── 3. Alerts for OCCUPIED rooms ──────────────────────────────────
      const occupied_rooms = await room_occupancy_state.find({ state: 'occupied' }).lean();

      for (const rs of occupied_rooms) {
        try {
          // Hub offline check: skip ONLY if there has been zero sensor
          // activity for > 10 minutes. Use the most recent sensor
          // timestamp — not occupied_since, which doesn't update while
          // the person stays in the room. This prevents skipping rooms
          // that are actively receiving sensor data but whose hub
          // service is incorrectly reporting offline.
          if (offline_residents.has(String(rs.resident))) {
            const last_master_t = rs.last_master_event_at
              ? new Date(rs.last_master_event_at).getTime() : 0;
            const last_curtain_t = rs.last_curtain_event_at
              ? new Date(rs.last_curtain_event_at).getTime() : 0;
            const last_door_t = rs.last_door_event_at
              ? new Date(rs.last_door_event_at).getTime() : 0;
            const last_any_sensor = Math.max(last_master_t, last_curtain_t, last_door_t);
            const since_last_sensor_min = last_any_sensor > 0
              ? (now - last_any_sensor) / 60000
              : Infinity;

            if (since_last_sensor_min > 10) {
              console.log(
                `[occupancy-cron] SKIP ${rs.occupancy_group}: resident ${rs.resident} ` +
                  `hub offline & no sensor activity for ${since_last_sensor_min.toFixed(1)} min (stale)`,
              );
              continue;
            }
            console.log(
              `[occupancy-cron] ${rs.occupancy_group}: hub marked offline but last ` +
                `sensor ${since_last_sensor_min.toFixed(1)} min ago — proceeding with alerts`,
            );
          }
          if (!rs.occupied_since) continue;

          // Load settings
          const settings = await room_occupancy_settings
            .findOne({
              resident: rs.resident,
              occupancy_group: rs.occupancy_group,
              is_active: true,
            })
            .lean();

          const is_test_mode = settings?.test_mode === true || (!settings && test_mode_enabled);

          // Fetch resident & user for notifications
          const resident_info = await resident.findById(rs.resident).lean();
          if (!resident_info?.creator) continue;

          const user_info = await user
            .findById(resident_info.creator)
            .select('_id notifications_enabled muted_alert_devices')
            .lean();

          const room_label = rs.room_label || 'Room';
          // Use "someone" instead of actual resident name for privacy
          const resident_name = 'Someone';

          // ── Diagnostic: log occupied room evaluation ───────────────────
          const diag_occupied_min = (now - new Date(rs.occupied_since).getTime()) / 60000;
          console.log(
            `[occupancy-cron] evaluating ${rs.occupancy_group}: ` +
              `occupied ${diag_occupied_min.toFixed(1)} min, ` +
              `master_active=${rs.master_is_active}, ` +
              `stillness_sent=${rs.stillness_alert_sent}, ` +
              `long_stay_level=${rs.long_stay_level_reached || 0}, ` +
              `test_mode=${is_test_mode}`,
          );

          // ── 3a. STILLNESS ALERT (Req 2) ─────────────────────────────────
          // Master=false + no other sensor activity for threshold → P0
          if (!rs.master_is_active && rs.last_master_false_at && !rs.stillness_alert_sent) {
            const stillness_threshold_min = is_test_mode
              ? test_stillness_threshold_min
              : (settings?.stillness_threshold_min ?? 1);
            const since_master_false = (now - new Date(rs.last_master_false_at).getTime()) / 60000;

            // Check no door/curtain events since master went false
            const master_false_time = new Date(rs.last_master_false_at).getTime();
            const last_door = rs.last_door_event_at ? new Date(rs.last_door_event_at).getTime() : 0;
            const last_curtain = rs.last_curtain_event_at
              ? new Date(rs.last_curtain_event_at).getTime()
              : 0;

            const no_other_activity =
              last_door <= master_false_time && last_curtain <= master_false_time;

            if (since_master_false >= stillness_threshold_min && no_other_activity) {
              // Fire stillness P0 notification
              const stillness_log = await alert_log.create({
                title: 'No movement detected — please check',
                description:
                  `Someone is in the ${room_label} but no movement has been detected. ` +
                  `Please check on them.`,
                resident: resident_info._id,
                device: rs.room_motion_device || rs.threshold_device || rs.door_device,
                device_type: 'zigbee',
                alert_level: 'emergency',
                is_resolved: false,
                meta: {
                  sensor_type: 'occupancy_group',
                  occupancy_group: rs.occupancy_group,
                  room: room_label,
                  alert_type: 'stillness_p0',
                  since_master_false_min: +since_master_false.toFixed(2),
                },
              });

              await room_occupancy_state.updateOne(
                { _id: rs._id },
                {
                  $set: {
                    stillness_alert_sent: true,
                    stillness_alert_sent_at: new Date(),
                    stillness_alert_log_id: stillness_log._id,
                  },
                },
                { strict: false },
              );

              // Socket
              if (user_info?._id && !is_alert_muted(user_info, DeviceCategory.MOTION_PRESENCE)) {
                socket_service.send_to_user(user_info._id.toString(), 'occupancy_no_motion_alert', {
                  occupancy_group: rs.occupancy_group,
                  room: room_label,
                  severity: 'emergency',
                  is_immediate_p0: true,
                  time: new Date().toISOString(),
                  alert_log_id: stillness_log._id,
                });
              }

              // Push
              if (user_info?._id) {
                await dispatch_notification({
                  backend_event: 'OCCUPANCY_NO_MOTION',
                  user_id: user_info._id,
                  title: 'No movement detected — please check',
                  severity: 'emergency',
                  template_vars: {
                    resident: resident_name,
                    location: room_label,
                    residentId: resident_info._id ? resident_info._id.toString() : undefined,
                    threshold: stillness_threshold_min,
                  },
                  data: {
                    resident: resident_info._id.toString(),
                    room: room_label,
                    occupancy_group: rs.occupancy_group,
                    alert_log_id: stillness_log._id.toString(),
                    is_immediate_p0: true,
                  },
                });
              }

              console.log(
                `[occupancy-cron] ${rs.occupancy_group} STILLNESS P0 — ` +
                  `master=false for ${since_master_false.toFixed(1)} min, no other activity`,
              );
            }
          }

          // ── 3b. LONG STAY ALERT — 3 escalating levels ───────────────────
          {
            const occupied_min = (now - new Date(rs.occupied_since).getTime()) / 60000;
            const emergency_repeat_min = is_test_mode
              ? test_emergency_repeat_min
              : (settings?.emergency_repeat_interval_min ?? 5);

            // Thresholds: default [30, 35, 40], test [3, 3.5, 4]
            let long_stay_thresholds = is_test_mode
              ? [...test_long_stay_thresholds]
              : [
                  settings?.long_stay_level_1_min ?? 30,
                  settings?.long_stay_level_2_min ?? 35,
                  settings?.long_stay_level_3_min ?? 40,
                ];

            // Night mode overrides (skipped in test mode)
            if (settings?.night_mode_enabled && !is_test_mode) {
              const now_str = get_current_ist_time_str();
              if (
                is_within_window(
                  now_str,
                  settings.night_from || '22:00',
                  settings.night_to || '06:00',
                )
              ) {
                long_stay_thresholds = [
                  settings.night_long_stay_level_1_min ?? 60,
                  settings.night_long_stay_level_2_min ?? 65,
                  settings.night_long_stay_level_3_min ?? 70,
                ];
              }
            }

            let current_level = rs.long_stay_level_reached || 0;

            // Check each level
            for (let i = 0; i < long_stay_levels.length; i++) {
              const lv = long_stay_levels[i];
              const threshold = long_stay_thresholds[i];
              if (current_level >= lv.level) continue;
              if (occupied_min < threshold) break;

              const new_alert = await alert_log.create({
                title: lv.title,
                description: `${room_label} — occupied for ${format_duration(occupied_min)} (level ${lv.level})`,
                resident: resident_info._id,
                device: rs.room_motion_device || rs.threshold_device || rs.door_device,
                device_type: 'zigbee',
                alert_level: lv.alert_level,
                is_resolved: false,
                meta: {
                  sensor_type: 'occupancy_group',
                  occupancy_group: rs.occupancy_group,
                  room: room_label,
                  duration_min: +occupied_min.toFixed(2),
                  alert_type: 'long_stay',
                  level: lv.level,
                },
              });

              await room_occupancy_state.updateOne(
                { _id: rs._id },
                {
                  $set: {
                    long_stay_level_reached: lv.level,
                    [`long_stay_level_${lv.level}_time`]: new Date(),
                    [`long_stay_level_${lv.level}_log_id`]: new_alert._id,
                  },
                },
                { strict: false },
              );
              current_level = lv.level;

              // Socket
              if (user_info?._id && !is_alert_muted(user_info, DeviceCategory.MOTION_PRESENCE)) {
                socket_service.send_to_user(user_info._id.toString(), 'occupancy_long_stay_alert', {
                  occupancy_group: rs.occupancy_group,
                  room: room_label,
                  duration: format_duration(occupied_min),
                  duration_min: +occupied_min.toFixed(2),
                  level: lv.level,
                  severity: lv.severity,
                  time: new Date().toISOString(),
                  alert_log_id: new_alert._id,
                  is_p0_fullscreen: !!lv.is_p0_fullscreen,
                  is_immediate_p0: !!lv.is_p0_fullscreen,
                  requires_acknowledgement: !!lv.requires_acknowledgement,
                });
              }

              // Push
              if (user_info?._id) {
                await dispatch_notification({
                  backend_event: 'OCCUPANCY_LONG_STAY',
                  user_id: user_info._id,
                  title: lv.title,
                  severity: lv.severity,
                  template_vars: {
                    resident: resident_name,
                    location: room_label,
                    residentId: resident_info._id ? resident_info._id.toString() : undefined,
                    threshold,
                  },
                  data: {
                    resident: resident_info._id.toString(),
                    room: room_label,
                    occupancy_group: rs.occupancy_group,
                    alert_log_id: new_alert._id.toString(),
                    duration_min: +occupied_min.toFixed(2),
                    level: lv.level,
                    is_p0_fullscreen: !!lv.is_p0_fullscreen,
                    is_immediate_p0: !!lv.is_p0_fullscreen,
                    requires_acknowledgement: !!lv.requires_acknowledgement,
                  },
                });
              }

              console.log(
                `[occupancy-cron] ${rs.occupancy_group} LONG_STAY L${lv.level} — ` +
                  `${occupied_min.toFixed(1)} min`,
              );

              // Only fire ONE level per cron tick so notifications arrive
              // at staggered intervals, not all at once.
              break;
            }

            // ── Emergency repeat loop after L3 ────────────────────────────
            if (current_level >= 3) {
              // SAFETY RE-CHECK: re-read state from DB to prevent firing
              // notifications after the room has already gone vacant.
              // The occupied_rooms query at the top of this section may be
              // stale if a state transition happened since the query ran.
              const fresh_state = await room_occupancy_state
                .findOne({ _id: rs._id })
                .select('state long_stay_level_3_log_id long_stay_last_emergency_repeat_at long_stay_level_3_time')
                .lean();
              if (!fresh_state || fresh_state.state !== 'occupied') {
                console.log(
                  `[occupancy-cron] ${rs.occupancy_group} SKIP emergency repeat — ` +
                    `state is now ${fresh_state?.state || 'missing'} (no longer occupied)`,
                );
              } else {
                const l3_log_id = fresh_state.long_stay_level_3_log_id || rs.long_stay_level_3_log_id;
                const last_repeat = (fresh_state.long_stay_last_emergency_repeat_at || rs.long_stay_last_emergency_repeat_at)
                  ? new Date(fresh_state.long_stay_last_emergency_repeat_at || rs.long_stay_last_emergency_repeat_at).getTime()
                  : (fresh_state.long_stay_level_3_time || rs.long_stay_level_3_time)
                    ? new Date(fresh_state.long_stay_level_3_time || rs.long_stay_level_3_time).getTime()
                    : 0;
                const repeat_ms = emergency_repeat_min * 60000;

                const acknowledged = await is_latest_emergency_acknowledged(l3_log_id);

                if (acknowledged) {
                  // L3 acknowledged — stop ALL repeating notifications
                  // (emergency repeats + any future stillness alerts).
                  // Reset alert tracking so no more alerts fire while
                  // the person remains in the room.
                  await room_occupancy_state.updateOne(
                    { _id: rs._id },
                    {
                      $set: {
                        long_stay_last_emergency_repeat_at: null,
                        stillness_alert_sent: true, // prevent re-fire
                      },
                    },
                    { strict: false },
                  );

                  console.log(
                    `[occupancy-cron] ${rs.occupancy_group} LONG_STAY L3 acknowledged — ` +
                      `stopping ALL repeating notifications (long stay + stillness)`,
                  );
                } else if (last_repeat > 0 && now - last_repeat >= repeat_ms) {
                  const lv = long_stay_levels[2]; // L3 emergency
                  const new_alert = await alert_log.create({
                    title: lv.title + ' (repeat)',
                    description: `${room_label} — occupied for ${format_duration(occupied_min)} (emergency repeat)`,
                    resident: resident_info._id,
                    device: rs.room_motion_device || rs.threshold_device || rs.door_device,
                    device_type: 'zigbee',
                    alert_level: lv.alert_level,
                    is_resolved: false,
                    meta: {
                      sensor_type: 'occupancy_group',
                      occupancy_group: rs.occupancy_group,
                      room: room_label,
                      duration_min: +occupied_min.toFixed(2),
                      alert_type: 'long_stay',
                      level: 3,
                      is_repeat: true,
                    },
                  });

                  await room_occupancy_state.updateOne(
                    { _id: rs._id },
                    {
                      $set: {
                        long_stay_last_emergency_repeat_at: new Date(),
                        long_stay_level_3_log_id: new_alert._id,
                      },
                    },
                    { strict: false },
                  );

                  // Socket
                  if (user_info?._id && !is_alert_muted(user_info, DeviceCategory.MOTION_PRESENCE)) {
                    socket_service.send_to_user(
                      user_info._id.toString(),
                      'occupancy_long_stay_alert',
                      {
                        occupancy_group: rs.occupancy_group,
                        room: room_label,
                        duration: format_duration(occupied_min),
                        duration_min: +occupied_min.toFixed(2),
                        level: 3,
                        severity: 'emergency',
                        is_repeat: true,
                        is_p0_fullscreen: true,
                        is_immediate_p0: true,
                        requires_acknowledgement: true,
                        time: new Date().toISOString(),
                        alert_log_id: new_alert._id,
                      },
                    );
                  }

                  // Push
                  if (user_info?._id) {
                    await dispatch_notification({
                      backend_event: 'OCCUPANCY_LONG_STAY',
                      user_id: user_info._id,
                      title: lv.title + ' (repeat)',
                      severity: lv.severity,
                      template_vars: {
                        resident: resident_name,
                        location: room_label,
                        residentId: resident_info._id ? resident_info._id.toString() : undefined,
                        threshold: +occupied_min.toFixed(1),
                      },
                      data: {
                        resident: resident_info._id.toString(),
                        room: room_label,
                        occupancy_group: rs.occupancy_group,
                        alert_log_id: new_alert._id.toString(),
                        duration_min: +occupied_min.toFixed(2),
                        level: 3,
                        is_repeat: true,
                        is_p0_fullscreen: true,
                        is_immediate_p0: true,
                        requires_acknowledgement: true,
                      },
                    });
                  }

                  console.log(
                    `[occupancy-cron] ${rs.occupancy_group} LONG_STAY EMERGENCY REPEAT — ` +
                      `${occupied_min.toFixed(1)} min`,
                  );
                }
              }
            }
          }

          // ── 3c. SAFETY CEILING — stuck occupied, zero signals ────────────
          if (!rs.safety_ceiling_alert_sent) {
            const safety_ceiling_hours = settings?.safety_ceiling_hours ?? 4;
            const ceiling_ms = safety_ceiling_hours * 60 * 60 * 1000;

            // All sensors must be silent for the full ceiling period
            const last_master = rs.last_master_event_at
              ? new Date(rs.last_master_event_at).getTime()
              : 0;
            const last_curtain = rs.last_curtain_event_at
              ? new Date(rs.last_curtain_event_at).getTime()
              : 0;
            const last_door = rs.last_door_event_at ? new Date(rs.last_door_event_at).getTime() : 0;
            const last_any_signal = Math.max(last_master, last_curtain, last_door);

            if (last_any_signal > 0 && now - last_any_signal >= ceiling_ms) {
              const hours_silent = ((now - last_any_signal) / 3600000).toFixed(1);

              const new_alert = await alert_log.create({
                title: 'Please check in',
                description: `${room_label} — unable to confirm status for ${hours_silent} hours. Please check on them when you can.`,
                resident: resident_info._id,
                device: rs.door_device || rs.room_motion_device || rs.threshold_device,
                device_type: 'zigbee',
                alert_level: 'warning',
                is_resolved: false,
                meta: {
                  sensor_type: 'occupancy_group',
                  occupancy_group: rs.occupancy_group,
                  room: room_label,
                  hours_silent: +hours_silent,
                  alert_type: 'occupancy_unconfirmed',
                },
              });

              await room_occupancy_state.updateOne(
                { _id: rs._id },
                {
                  $set: {
                    safety_ceiling_alert_sent: true,
                    safety_ceiling_alert_time: new Date(),
                    safety_ceiling_alert_log_id: new_alert._id,
                  },
                },
                { strict: false },
              );

              // Socket
              if (user_info?._id && !is_alert_muted(user_info, DeviceCategory.MOTION_PRESENCE)) {
                socket_service.send_to_user(
                  user_info._id.toString(),
                  'occupancy_unconfirmed_alert',
                  {
                    occupancy_group: rs.occupancy_group,
                    room: room_label,
                    hours_silent: +hours_silent,
                    time: new Date().toISOString(),
                    alert_log_id: new_alert._id,
                  },
                );
              }

              // Push
              if (user_info?._id) {
                await dispatch_notification({
                  backend_event: 'OCCUPANCY_UNCONFIRMED',
                  user_id: user_info._id,
                  template_vars: {
                    resident: resident_name,
                    location: room_label,
                    residentId: resident_info._id ? resident_info._id.toString() : undefined,
                  },
                  data: {
                    resident: resident_info._id.toString(),
                    room: room_label,
                    occupancy_group: rs.occupancy_group,
                    alert_log_id: new_alert._id.toString(),
                    hours_silent: +hours_silent,
                  },
                });
              }

              console.log(
                `[occupancy-cron] ${rs.occupancy_group} UNCONFIRMED alert — ` +
                  `${hours_silent}h silent`,
              );
            }
          }
        } catch (room_err) {
          console.error(`[occupancy-cron] room error for ${rs.occupancy_group}:`, room_err.message);
        }
      }
    } catch (err) {
      console.error('[occupancy-cron] checker crashed:', err.message);
    }
  });
};

export { start_occupancy_alert_checker };
export default { start_occupancy_alert_checker };
