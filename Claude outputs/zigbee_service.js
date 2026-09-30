import zigbee_logs_service from '../service/health_logs.js';
import socket_service from '../utils/socket.js';
import { get_device_details } from './device_service.js';
import alert_state from '../models/alert_state.js';
import alert_log from '../models/alert_log.js';
import room_state_model from '../models/room_state.js';
import contact_alert_settings from '../models/contact_alert_settings.js';
import resident_model from '../models/resident.js';
import { dispatch_notification, is_alert_muted } from './notification_service.js';
import { DeviceCategory } from '../constants/notification_events.js';
import { handle_occupancy_event } from './room_occupancy_service.js';
import { handle_occupancy_v4_event } from './occupancy_v4_service.js';

// ── IST time-window helpers (same logic as health_logs.js) ────────────────
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

const find_mapped_zigbee_device = async (zigbee_id) =>
  await get_device_details({
    $or: [{ id: zigbee_id }, { zigbee_id }],
    type: 'Zigbee',
    status: 'active',
  });

// Returns true when this contact sensor is paired to a motion sensor via
// paired_window_ieee.  Such sensors are part of the motion setup — their
// open/close events should NOT produce standalone door/window alerts, push
// notifications, or socket updates in the user app.
const is_paired_contact = async (device_info) => {
  const ieee = device_info?.ieee || device_info?.id;
  if (!ieee) return false;
  const motion_parent = await get_device_details({
    type: 'Zigbee',
    paired_window_ieee: ieee,
    status: 'active',
  });
  return !!motion_parent;
};

// ── Home-to-resident resolution helper ───────────────────────────────────────
// For home-mapped devices (Zigbee, CpPlus) where resident_info is null,
// look up the resident through the home. Each home has resident(s); we pick
// the first active one. This ensures alert_log, room_state, and push
// notifications still get a valid resident reference.
const resolve_resident_for_device = async (device_info, resident_info) => {
  if (resident_info) return resident_info;
  if (!device_info?.home) return null;
  const found = await resident_model.findOne({ home: device_info.home }).lean();
  return found || null;
};

// Helper to get the resident ObjectId for a device — either directly from the
// device record (GLK/BpMonitor path) or resolved through the home (Zigbee path).
const get_resident_id_for_device = async (device_info) => {
  if (device_info?.resident) return device_info.resident;
  if (!device_info?.home) return null;
  const found = await resident_model.findOne({ home: device_info.home }).lean();
  return found?._id || null;
};

const select_device_send_data = async (type, body) => {
  const { target_user, data, device, device_info, resident_info } = body;

  // ── Occupancy group routing ─────────────────────────────────────────────
  // If this device has an occupancy_group + sensor_role, route to the
  // appropriate occupancy service. V4 roles ('doorway', 'inside') go to
  // the new two-sensor state machine; v3 roles go to the legacy 3-device
  // service.
  if (device_info?.occupancy_group && device_info?.sensor_role) {
    const v4_roles = ['doorway', 'inside'];
    if (v4_roles.includes(device_info.sensor_role)) {
      // ── V4 two-sensor occupancy ──────────────────────────────────────
      try {
        await handle_occupancy_v4_event(device_info.sensor_role, body);
      } catch (err) {
        console.error(`[zigbee] v4 occupancy event failed for ${device}:`, err.message);
      }
      return;
    }

    // ── V3 three-device occupancy ────────────────────────────────────
    try {
      await handle_occupancy_event(device_info.sensor_role, body);
    } catch (err) {
      console.error(`[zigbee] occupancy event failed for ${device}:`, err.message);
    }
    // For contact-type occupancy sensors, ALSO run the standalone contact
    // handler so door open/close alerts (if monitoring is enabled) still
    // fire alongside the occupancy logic.
    if (device_info.sensor_role === 'occupancy_door' && type === 'contact') {
      if (data.contact !== undefined) {
        await handle_contact_sensor(target_user, data, device, device_info, resident_info);
      }
    }
    return;
  }

  switch (type) {
    case 'motion':
      await handle_motion_sensor(target_user, data, device, device_info, resident_info);
      break;

    case 'presence':
      await handle_presence_sensor(target_user, data, device, device_info, resident_info);
      break;

    case 'switch':
      // Save alert_log for every switch action regardless of socket state
      if (data.action) await handle_switch(target_user, data, device, device_info, resident_info);
      break;

    case 'contact':
      if (data.contact !== undefined) {
        // Skip standalone alerts/socket/push for contact sensors that are
        // paired with a motion sensor (paired_window_ieee).  Their events
        // are consumed by the motion setup, not as independent door alerts.
        const paired = await is_paired_contact(device_info);
        if (!paired) {
          await handle_contact_sensor(target_user, data, device, device_info, resident_info);
        } else {
          console.log(
            `[contact] ${device} is paired to a motion sensor — skipping standalone alerts`,
          );
        }
      }
      break;
  }
};

// ── Room state helper ─────────────────────────────────────────────────────────
// Upserts the room_state document for (resident, room) then applies `updates`.
// Emits a `room_state_update` socket event if the user is online.
// For home-mapped devices (resident is null on device), resolves resident
// through the home so room_state tracking still works.
const apply_room_state_update = async (device_info, updates, target_user) => {
  if (!device_info?._id) return null;

  // Resolve resident: direct from device or via home lookup
  const resident_id = await get_resident_id_for_device(device_info);
  if (!resident_id) return null;

  const room = device_info.room || 'bathroom';

  const rs = await room_state_model.findOneAndUpdate(
    { resident: resident_id, room },
    { $setOnInsert: { resident: resident_id, room } },
    { upsert: true, new: true },
  );

  await room_state_model.updateOne({ _id: rs._id }, { $set: updates });

  const updated_state = { ...rs.toObject(), ...updates };

  if (target_user?._id) {
    socket_service.send_to_user(target_user._id.toString(), 'room_state_update', {
      room,
      resident: resident_id,
      ...updated_state,
    });
  }

  return updated_state;
};

// ── Motion sensor handler ─────────────────────────────────────────────────────
// Maintains the existing bathroom session (alert_state) AND updates room_state
// so the combined motion+presence logic can track no-motion alerts.
// Dispatches MOTION_DETECTED / MOTION_STOPPED feed-only notifications.
const handle_motion_sensor = async (target_user, data, device, device_info, resident_info) => {
  // Resolve resident for home-mapped devices
  const resolved_resident = await resolve_resident_for_device(device_info, resident_info);

  // ── Bathroom session: start on first PIR=true ──────────────────────────
  // Session END is managed solely by the cron (bathroom_alert_checker) via
  // the PIR grace period.  Ending the session here on PIR=false conflicts
  // with the grace period: PIR goes false after ~30s of stillness, the
  // real-time handler would kill the session, then the cron would restart
  // it 0-2s later with a new session_start, losing the original entry time
  // and resetting the alert escalation chain.
  const state = await alert_state.findOneAndUpdate(
    { key: device },
    { $setOnInsert: { key: device, type: 'bathroom' } },
    { upsert: true, new: true },
  );

  if (data.occupancy === true && !state.session_start) {
    await alert_state.updateOne({ key: device }, { session_start: new Date() });
  }

  const bathroom_data = await zigbee_logs_service.get_bathroom_data(device);

  if (target_user?._id) {
    socket_service.send_to_user(target_user._id.toString(), 'bathroom_update', bathroom_data);
  }

  // ── Room state update ────────────────────────────────────────────────────
  const location_label = device_info?.room || 'bathroom';
  let new_state = null;

  if (device_info) {
    const room = device_info.room || 'bathroom';
    // Use resolved resident for room_state query
    const resident_id = resolved_resident?._id || device_info.resident;
    const current_rs = resident_id
      ? await room_state_model.findOne({ resident: resident_id, room }).lean()
      : null;

    const room_update = {
      motion_active: !!data.occupancy,
      motion_device: device_info._id,
    };

    if (data.occupancy) {
      room_update.motion_last_seen = new Date();
      room_update.no_motion_timer_start = null; // motion detected → cancel no-motion timer
      // Reset alert tracking — motion returned, so the previous no-motion
      // alert cycle is over. Without this the room-cron sees a stale
      // 'emergency' level and immediately re-fires on the next brief pause.
      room_update.no_motion_alert_level = null;
      room_update.no_motion_alert_time = null;
      room_update.no_motion_alert_log_id = null;
      room_update.state = 'activity_detected';
    } else {
      // Motion stopped — check if presence sensor still active
      if (current_rs?.presence_active) {
        room_update.state = 'occupied';
        // Start no-motion timer if not already running
        if (!current_rs?.no_motion_timer_start) {
          room_update.no_motion_timer_start = new Date();
        }
      } else {
        room_update.state = 'empty';
      }
    }

    const updated = await apply_room_state_update(device_info, room_update, target_user);
    new_state = updated?.state || room_update.state;
  }

  // ── Feed-only notifications (P3, matrix #31/#32) ─────────────────────────
  if (target_user?._id) {
    const motion_event = data.occupancy ? 'MOTION_DETECTED' : 'MOTION_STOPPED';

    dispatch_notification({
      backend_event: motion_event,
      user_id: target_user._id,
      template_vars: { location: location_label },
      data: {
        device,
        device_id: device_info?._id ? device_info._id.toString() : undefined,
        room: location_label,
        resident: resolved_resident?._id ? resolved_resident._id.toString() : undefined,
      },
    }).catch((err) => console.error(`[motion] ${motion_event} dispatch failed:`, err.message));

    // ROOM_OCCUPIED / ROOM_VACANT based on the computed room state (matrix #33/#34).
    // Only fire on actual state transitions to avoid spamming on every motion tick.
    if (new_state === 'activity_detected' || new_state === 'occupied') {
      // Room is occupied (either active motion or presence-only)
      dispatch_notification({
        backend_event: 'ROOM_OCCUPIED',
        user_id: target_user._id,
        template_vars: { location: location_label },
        data: {
          device,
          device_id: device_info?._id ? device_info._id.toString() : undefined,
          room: location_label,
          resident: resolved_resident?._id ? resolved_resident._id.toString() : undefined,
        },
      }).catch((err) => console.error('[motion] ROOM_OCCUPIED dispatch failed:', err.message));
    } else if (new_state === 'empty') {
      dispatch_notification({
        backend_event: 'ROOM_VACANT',
        user_id: target_user._id,
        template_vars: { location: location_label },
        data: {
          device,
          device_id: device_info?._id ? device_info._id.toString() : undefined,
          room: location_label,
          resident: resolved_resident?._id ? resolved_resident._id.toString() : undefined,
        },
      }).catch((err) => console.error('[motion] ROOM_VACANT dispatch failed:', err.message));
    }
  }
};

// ── Presence sensor handler ───────────────────────────────────────────────────
// Updates room_state based on presence data (sustained occupancy).
// Does NOT touch alert_state — the bathroom alert_state is motion-only.
// Dispatches PRESENCE_DETECTED / PRESENCE_LOST feed-only notifications.
const handle_presence_sensor = async (target_user, data, device, device_info, resident_info) => {
  if (!device_info) return;

  // Resolve resident for home-mapped devices
  const resolved_resident = await resolve_resident_for_device(device_info, resident_info);

  const room = device_info.room || 'bathroom';
  const location_label = device_info.room || 'bathroom';
  // Use resolved resident for room_state query
  const resident_id = resolved_resident?._id || device_info.resident;
  const current_rs = resident_id
    ? await room_state_model.findOne({ resident: resident_id, room }).lean()
    : null;

  const room_update = {
    presence_active: !!data.occupancy,
    presence_device: device_info._id,
  };

  if (data.occupancy) {
    // Presence detected
    if (!current_rs?.presence_active) {
      // Person just entered — record arrival times
      room_update.presence_since = new Date();
      room_update.session_start = current_rs?.session_start || new Date();
    }
    // Determine combined state
    if (current_rs?.motion_active) {
      room_update.state = 'activity_detected';
    } else {
      room_update.state = 'occupied';
      // Start no-motion timer if not already running
      if (!current_rs?.no_motion_timer_start) {
        room_update.no_motion_timer_start = new Date();
      }
    }
  } else {
    // Presence gone — person left; reset all room tracking
    room_update.state = 'empty';
    room_update.presence_since = null;
    room_update.session_start = null;
    room_update.no_motion_timer_start = null;
    room_update.no_motion_alert_level = null;
    room_update.no_motion_alert_time = null;
    room_update.no_motion_alert_log_id = null;
  }

  await apply_room_state_update(device_info, room_update, target_user);

  // Emit bathroom_data as well (backward compat — some clients use bathroom_update)
  const bathroom_data = await zigbee_logs_service.get_bathroom_data(device);
  if (target_user?._id) {
    socket_service.send_to_user(target_user._id.toString(), 'bathroom_update', bathroom_data);
  }

  // ── Feed-only notifications (P3, matrix #29/#30) ─────────────────────────
  if (target_user?._id) {
    const presence_event = data.occupancy ? 'PRESENCE_DETECTED' : 'PRESENCE_LOST';

    dispatch_notification({
      backend_event: presence_event,
      user_id: target_user._id,
      template_vars: { location: location_label },
      data: {
        device,
        device_id: device_info?._id ? device_info._id.toString() : undefined,
        room: location_label,
        resident: resolved_resident?._id ? resolved_resident._id.toString() : undefined,
      },
    }).catch((err) => console.error(`[presence] ${presence_event} dispatch failed:`, err.message));

    // ROOM_OCCUPIED / ROOM_VACANT based on the computed room state (matrix #33/#34).
    if (room_update.state === 'activity_detected' || room_update.state === 'occupied') {
      dispatch_notification({
        backend_event: 'ROOM_OCCUPIED',
        user_id: target_user._id,
        template_vars: { location: location_label },
        data: {
          device,
          device_id: device_info?._id ? device_info._id.toString() : undefined,
          room: location_label,
          resident: resolved_resident?._id ? resolved_resident._id.toString() : undefined,
        },
      }).catch((err) => console.error('[presence] ROOM_OCCUPIED dispatch failed:', err.message));
    } else if (room_update.state === 'empty') {
      dispatch_notification({
        backend_event: 'ROOM_VACANT',
        user_id: target_user._id,
        template_vars: { location: location_label },
        data: {
          device,
          device_id: device_info?._id ? device_info._id.toString() : undefined,
          room: location_label,
          resident: resolved_resident?._id ? resolved_resident._id.toString() : undefined,
        },
      }).catch((err) => console.error('[presence] ROOM_VACANT dispatch failed:', err.message));
    }
  }
};

// Saves every switch action to alert history and emits socket if user is online.
const handle_switch = async (target_user, data, device, device_info, resident_info) => {
  // Resolve resident for home-mapped devices (emergency button is Zigbee → home-mapped)
  const resolved_resident = await resolve_resident_for_device(device_info, resident_info);

  // Count how many times this action (e.g. 'long' press for the emergency
  // button) has fired on this device so far in the current calendar month.
  // The zigbee_log entry for this event is already written by the time
  // select_device_send_data runs, so this count includes the current click.
  const click_count_this_month = await zigbee_logs_service.get_switch_click_count_this_month(
    device,
    data.action,
  );

  // Always persist to alert history so it appears in the alert log with resolved/unresolved status.
  // The created doc's _id is kept (not discarded) so it can be handed to the
  // app as `alert_id` in the push payload below -- the app's full-screen
  // "Acknowledge" button needs it to call
  // PATCH /api/user/devices/:device_id/alerts/:alert_id (device_controller.resolve_alert).
  let created_alert = null;
  if (device_info?._id && resolved_resident?._id) {
    created_alert = await alert_log.create({
      title: `Switch ${data.action}`,
      description: `Zigbee switch triggered: ${data.action}`,
      resident: resolved_resident._id,
      device: device_info._id,
      device_type: 'zigbee',
      alert_level: 'info',
      is_resolved: false,
      meta: { action: data.action, sensor_type: 'switch', click_count_this_month },
    });
  } else {
    console.warn(
      `[switch] cannot create alert_log for ${device}: ` +
        `device_id=${device_info?._id || 'missing'}, ` +
        `resident_id=${resolved_resident?._id || 'missing'} ` +
        `(home=${device_info?.home || 'none'})`,
    );
  }
  // Socket emit — send_to_user uses io.to(userId) room-based emission, so
  // it only needs the user's _id, not socket_id (which is unreliable due to
  // disconnect race conditions). If no sockets are in the room, the emit is
  // a harmless no-op.
  if (target_user?._id && !is_alert_muted(target_user, DeviceCategory.BUTTON)) {
    console.log(`[switch] emitting switch_update to user ${target_user._id}`);
    socket_service.send_to_user(target_user._id.toString(), 'switch_update', {
      device,
      action: data.action,
      time: new Date(),
      is_active: true,
      click_count_this_month,
    });
  }

  // Push (matrix event #16, EMERGENCY_BUTTON_PRESSED, P0) -- unlike the
  // socket emit above, this must fire even when the caregiver's app is
  // closed/backgrounded, so it does NOT require target_user.socket_id.
  //
  // `title` here is the app's fixed full-screen hero text per the Flutter
  // team's "Full-Screen Alert Push" spec (data.title, shown uppercase) --
  // it's intentionally generic ("EMERGENCY"), not a description. The
  // human-readable sentence lives in `body`, which still reaches iOS via
  // apns.payload.aps.alert.body (see push_service.js).
  if (target_user?._id) {
    await dispatch_notification({
      backend_event: 'EMERGENCY_BUTTON_PRESSED',
      user_id: target_user._id,
      title: 'EMERGENCY',
      body: `${resolved_resident?.name || 'Resident'} pressed the emergency button.`,
      data: {
        device,
        device_id: device_info?._id ? device_info._id.toString() : undefined,
        room: device_info?.room || undefined,
        resident: resolved_resident?._id ? resolved_resident._id.toString() : undefined,
        alert_id: created_alert?._id ? created_alert._id.toString() : undefined,
        action: data.action,
      },
    });
  }
};

// Best-effort door-vs-window classification — mirrors classify_contact_device
// in health_logs.js. Matches on the word "window"; everything else is a door.
const classify_contact = (device_info) => {
  const label =
    `${device_info?.room || ''} ${device_info?.id || device_info?.zigbee_id || ''}`.toLowerCase();
  return label.includes('window') ? 'window' : 'door';
};

// Updates contact state, creates feed-only alert_log entries for open/close,
// dispatches push-eligible notifications, and emits real-time socket update.
// "Left open" escalation (P2 push, repeat every 15 min) is handled by
// start_contact_alert_checker in health_logs.js.
const handle_contact_sensor = async (target_user, data, device, device_info, resident_info) => {
  // Resolve resident for home-mapped devices
  const resolved_resident = await resolve_resident_for_device(device_info, resident_info);

  const contact_data = await zigbee_logs_service.get_contact_data(device);

  // ── Determine door vs window ─────────────────────────────────────────────
  const contact_type = classify_contact(device_info);
  const is_window = contact_type === 'window';
  const location_label = device_info?.room || (is_window ? 'window' : 'door');

  // ── Socket emit (real-time UI update) ────────────────────────────────────
  if (target_user?._id && !is_alert_muted(target_user, DeviceCategory.WINDOW_DOOR)) {
    socket_service.send_to_user(target_user._id.toString(), 'contact_update', {
      ...contact_data,
      contact_type,
      location: location_label,
    });
  }

  // ── Monitoring time-window check ────────────────────────────────────────
  // Alerts (push, alert_log, escalation) only fire when BOTH conditions hold:
  //   1. An active contact_alert_settings record exists (is_active: true)
  //   2. Current IST time falls inside [monitor_from, monitor_to]
  // When no active settings exist the user hasn't enabled monitoring for this
  // sensor, so we skip all alerts. The real-time socket event above still
  // reaches the app for live UI updates regardless.
  let outside_window = true; // default: no alerts unless inside an active window
  if (device_info?._id) {
    const settings = await contact_alert_settings.findOne({
      device: device_info._id,
      is_active: true,
    });
    if (settings) {
      const now_str = get_current_ist_time_str();
      outside_window = !is_within_window(now_str, settings.monitor_from, settings.monitor_to);
      if (outside_window) {
        console.log(
          `[contact] ${device} outside monitoring window (${settings.monitor_from}-${settings.monitor_to}, now=${now_str}) — skipping alerts`,
        );
      }
    } else {
      console.log(`[contact] ${device} no active monitoring settings — skipping alerts`);
    }
  }

  // ── contact=false → door/window OPENED ───────────────────────────────────
  if (data.contact === false && !outside_window) {
    // Start tracking session in alert_state
    const state = await alert_state.findOneAndUpdate(
      { key: device },
      { $setOnInsert: { key: device, type: 'contact' } },
      { upsert: true, new: true },
    );

    if (!state.session_start) {
      await alert_state.updateOne({ key: device }, { session_start: new Date() });
    }

    // Create alert_log (P3 Information) — matrix rows #18/#21
    const backend_event = is_window ? 'WINDOW_OPENED' : 'DOOR_OPENED';
    const title = is_window ? 'Window Opened' : 'Door Opened';
    const body = `The ${location_label} ${contact_type} has been opened.`;

    let created_alert = null;
    if (device_info?._id && resolved_resident?._id) {
      created_alert = await alert_log.create({
        title,
        description: body,
        resident: resolved_resident._id,
        device: device_info._id,
        device_type: 'zigbee',
        alert_level: 'info',
        is_resolved: false,
        meta: {
          sensor_type: 'contact',
          contact_type,
          event: backend_event,
          location: location_label,
        },
      });
    }

    // Dispatch push notification for DOOR_OPENED / WINDOW_OPENED.
    // bypass_quiet_hours: the user explicitly configured a monitoring window
    // for this sensor, so their intent to receive alerts inside that window
    // must override the account-level quiet-hours setting.
    if (target_user?._id) {
      await dispatch_notification({
        backend_event,
        user_id: target_user._id,
        template_vars: { location: location_label },
        bypass_quiet_hours: true,
        data: {
          device,
          device_id: device_info?._id ? device_info._id.toString() : undefined,
          room: device_info?.room || undefined,
          resident: resolved_resident?._id ? resolved_resident._id.toString() : undefined,
          alert_id: created_alert?._id ? created_alert._id.toString() : undefined,
          contact_type,
        },
      });
    }
  }

  // ── contact=true → door/window CLOSED ────────────────────────────────────
  if (data.contact === true) {
    // Always resolve alert state + pending alerts regardless of window —
    // if a door was opened inside the window and closes after the window
    // ends, we still want to clear the session so the cron doesn't keep
    // escalating.
    const state = await alert_state.findOne({ key: device });

    // Auto-resolve any pending "left open" alert
    if (state?.last_alert_log_id) {
      await alert_log.updateMany(
        { _id: state.last_alert_log_id, is_resolved: false },
        { is_resolved: true, resolved_at: new Date() },
      );
    }

    // Reset alert_state session
    await alert_state.updateOne(
      { key: device },
      {
        session_start: null,
        last_alert_level: null,
        last_alert_time: null,
        last_alert_log_id: null,
      },
    );

    // Skip push + alert_log for the close event if outside the window.
    if (outside_window) return;

    // Create feed-only alert_log for the close event — matrix rows #19/#22
    const backend_event = is_window ? 'WINDOW_CLOSED' : 'DOOR_CLOSED';
    const title = is_window ? 'Window Closed' : 'Door Closed';
    const body = `The ${location_label} ${contact_type} has been closed.`;

    if (device_info?._id && resolved_resident?._id) {
      await alert_log.create({
        title,
        description: body,
        resident: resolved_resident._id,
        device: device_info._id,
        device_type: 'zigbee',
        alert_level: 'info',
        is_resolved: true,
        resolved_at: new Date(),
        meta: {
          sensor_type: 'contact',
          contact_type,
          event: backend_event,
          location: location_label,
        },
      });
    }

    // Dispatch notification for DOOR_CLOSED / WINDOW_CLOSED.
    // Same bypass reasoning as the OPENED dispatch above.
    if (target_user?._id) {
      await dispatch_notification({
        backend_event,
        user_id: target_user._id,
        template_vars: { location: location_label },
        bypass_quiet_hours: true,
        data: {
          device,
          device_id: device_info?._id ? device_info._id.toString() : undefined,
          room: device_info?.room || undefined,
          resident: resolved_resident?._id ? resolved_resident._id.toString() : undefined,
          contact_type,
        },
      });
    }
  }
};

export {
  find_mapped_zigbee_device,
  handle_motion_sensor,
  handle_presence_sensor,
  handle_switch,
  handle_contact_sensor,
  select_device_send_data,
};
