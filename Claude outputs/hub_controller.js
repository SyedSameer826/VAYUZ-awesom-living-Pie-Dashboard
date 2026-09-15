import { async_handler } from '../middleware/errorMiddleware.js';
import hub_service from '../service/hub_service.js';
import room_state_model from '../models/room_state.js';
import room_occupancy_state_model from '../models/room_occupancy_state.js';
import resident_model from '../models/resident.js';

// Pi -> backend heartbeat. Records liveness + graded internet level, and (inside
// the service) emits a `hub_status` socket event to the family app when the
// level changes or the hub comes back online.
const heartbeat = async_handler(async (req, res) => {
  const {
    hub_id,
    home,
    resident,
    internet_level,
    latency_ms,
    mains_status,
    tunnel_url,
    camera_count,
  } = req.body;
  if (!hub_id) {
    return res.status(400).json({ success: false, message: 'hub_id is required' });
  }

  const hub = await hub_service.record_heartbeat({
    hub_id,
    home,
    resident,
    internet_level,
    latency_ms,
    mains_status,
    tunnel_url,
    camera_count,
  });

  // ── Pending command delivery ──────────────────────────────────────────
  // If the app queued a shutdown/reboot, piggyback it on this heartbeat
  // response. Commands older than 5 minutes are stale (the hub was probably
  // offline when it was queued and came back much later) — discard them.
  let pending_command = null;
  if (hub.pending_command) {
    const age_ms = Date.now() - new Date(hub.command_requested_at).getTime();
    const max_age_ms = 5 * 60 * 1000; // 5 minutes

    if (age_ms <= max_age_ms) {
      pending_command = hub.pending_command;
      console.log(`🎛️  delivering "${pending_command}" command to hub ${hub.hub_id}`);
    } else {
      console.log(
        `🎛️  discarding stale "${hub.pending_command}" command for hub ${hub.hub_id} (${Math.round(age_ms / 1000)}s old)`,
      );
    }

    // Clear the command either way — delivered or expired.
    hub.pending_command = null;
    hub.command_requested_at = null;
    hub.command_requested_by = null;
    await hub.save();
  }

  const response_data = {
    hub_id: hub.hub_id,
    online: hub.online,
    internet_level: hub.internet_level,
  };
  if (pending_command) response_data.pending_command = pending_command;

  return res.status(200).json({ success: true, data: response_data });
});

// App -> backend: fetch the current hub status for a resident's home on load
// (the live updates thereafter arrive over the `hub_status` socket event).
const get_status = async_handler(async (req, res) => {
  const { resident } = req.params;
  const status = await hub_service.get_status_for_resident(resident);
  return res.status(200).json({ success: true, data: status });
});

// App -> backend: queue a shutdown or reboot command for the home's hub.
// The Pi will pick it up on its next heartbeat (~30s).
const send_command = async_handler(async (req, res) => {
  const { home_id, command } = req.body;
  if (!home_id || !command) {
    return res.status(400).json({ success: false, message: 'home_id and command are required' });
  }

  const result = await hub_service.send_command({
    home_id,
    command,
    user_id: req.user?._id || null,
  });

  return res.status(200).json({ success: true, data: result });
});

// Pi -> backend: reset all room state for a home after sensor setup/pairing.
// During installation, random sensor events produce stale room_state entries.
// This resets every room_state + room_occupancy_state document back to the
// clean "vacant / empty" baseline so monitoring starts fresh.
const sync_room_state = async_handler(async (req, res) => {
  const { home_id } = req.body;
  if (!home_id) {
    return res.status(400).json({ success: false, message: 'home_id is required' });
  }

  // Find every resident that belongs to this home.
  const residents = await resident_model.find({ home: home_id }).select('_id').lean();
  const resident_ids = residents.map((r) => r._id);

  if (!resident_ids.length) {
    return res.status(200).json({
      success: true,
      message: 'no residents found for this home — nothing to reset',
      room_state_reset: 0,
      occupancy_state_reset: 0,
    });
  }

  // Reset room_state documents (motion + presence standalone sensors).
  const room_state_result = await room_state_model.updateMany(
    { resident: { $in: resident_ids } },
    {
      $set: {
        motion_active: false,
        motion_last_seen: null,
        presence_active: false,
        presence_since: null,
        state: 'empty',
        session_start: null,
        no_motion_timer_start: null,
        no_motion_alert_level: null,
        no_motion_alert_time: null,
        no_motion_alert_log_id: null,
      },
    },
  );

  // Reset room_occupancy_state documents (3-device occupancy groups).
  const occupancy_result = await room_occupancy_state_model.updateMany(
    { resident: { $in: resident_ids } },
    {
      $set: {
        state: 'vacant',
        occupied_since: null,
        door_is_open: false,
        door_open_at: null,
        last_door_cycle_at: null,
        last_threshold_motion_at: null,
        last_room_motion_at: null,
        exit_pending_since: null,
        confirmation_deadline: null,
        long_stay_level_reached: 0,
        long_stay_level_1_time: null,
        long_stay_level_1_log_id: null,
        long_stay_level_2_time: null,
        long_stay_level_2_log_id: null,
        long_stay_level_3_time: null,
        long_stay_level_3_log_id: null,
        no_motion_level_reached: 0,
        no_motion_level_1_time: null,
        no_motion_level_1_log_id: null,
        no_motion_level_2_time: null,
        no_motion_level_2_log_id: null,
        no_motion_level_3_time: null,
        no_motion_level_3_log_id: null,
        safety_ceiling_alert_sent: false,
        safety_ceiling_alert_time: null,
        safety_ceiling_alert_log_id: null,
      },
    },
  );

  console.log(
    `🔄 room state sync: home=${home_id}, ` +
    `room_state=${room_state_result.modifiedCount}/${room_state_result.matchedCount}, ` +
    `occupancy_state=${occupancy_result.modifiedCount}/${occupancy_result.matchedCount}`,
  );

  return res.status(200).json({
    success: true,
    message: 'room state synced — all rooms reset to vacant/empty',
    room_state_reset: room_state_result.modifiedCount,
    occupancy_state_reset: occupancy_result.modifiedCount,
  });
});

export { heartbeat, get_status, send_command, sync_room_state };
