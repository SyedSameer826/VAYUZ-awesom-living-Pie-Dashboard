import { generate_token } from '../helper/index.js';
import { async_handler } from '../middleware/errorMiddleware.js';
import * as device_service from '../service/device_service.js';
import * as zigbee_settings_service from '../service/zigbee_settings_service.js';
import {
  rollback_altum_setup,
  verify_calibration_readiness,
} from '../service/altum_setup_recovery_service.js';
import {
  acknowledge_v4_alert,
  set_v4_away,
  get_v4_room_state,
} from '../service/occupancy_v4_service.js';
import device_model from '../models/device.js';
import alert_log from '../models/alert_log.js';
import resident_model from '../models/resident.js';

const create_device = async_handler(async (req, res) => {
  const {
    type,
    camera_id,
    sr_num,
    resident,
    client_id,
    client_secret,

    // 🔥 new (optional)
    id,
    ieee,
    sensor_type,
    room,
    stream_name,
    local_ip,
    // Multi-camera / multi-hub fields (CpPlus)
    hub_id,
    rtsp_url,
    // Home mapping (optional — auto-resolved from resident if omitted)
    home,
    // BpMonitor
    mac_address,
    // Motion + Window sensor pairing
    paired_motion_ieee,
    paired_window_ieee,
    // Occupancy group (optional — set via Pi Dashboard for room occupancy)
    occupancy_group,
    sensor_role,
  } = req.body;
  if (sr_num && type === 'Emfit') {
    const exist = await device_service.is_emfit_exist(sr_num);
    if (exist) {
      return res.status(400).json({
        success: false,
        message: 'Vital Tracker with this serial number already mapped with another resident',
      });
    }
  }
  const device = await device_service.create_device(
    type,
    camera_id,
    sr_num,
    resident,
    client_id,
    client_secret,
    id,
    ieee,
    sensor_type,
    room,
    stream_name,
    local_ip,
    hub_id,
    rtsp_url,
    home,
    mac_address,
    paired_motion_ieee,
    paired_window_ieee,
    occupancy_group,
    sensor_role,
  );

  res.status(201).json({
    success: true,
    data: device,
  });
});
const delete_device = async_handler(async (req, res) => {
  const { device } = req.params;
  // Zigbee devices are keyed by `ieee`; CP Plus cameras have no ieee, they're
  // keyed by `stream_name`. Match either so deleting a camera also removes it
  // from the backend (otherwise re-mapping would create duplicates).
  const device_exist = await device_service.get_device_details({
    $or: [{ ieee: device }, { stream_name: device }],
  });
  if (!device_exist) {
    return res.status(400).json({
      success: false,
      message: 'Device not found',
    });
  }
  const device_data = await device_service.delete_device(device_exist);
  res.status(200).json({
    success: true,
    data: { device_data, device_exist },
  });
});
const is_device_already_mapped_to_resident = async_handler(async (req, res) => {
  const { serial_no } = req.params;

  const result = await device_service.check_device(serial_no);

  res.status(200).json({
    success: true,
    ...result,
  });
});
const is_device_online = async_handler(async (req, res) => {
  const { serial_no } = req.params;

  const result = await device_service.is_device_online(serial_no);

  res.status(200).json({
    success: true,
    ...result,
  });
});
const get_device = async_handler(async (req, res) => {
  const { device } = req.params;
  const device_data = await device_service.get_device_by_id(device);
  res.status(200).json({
    success: true,
    data: device_data,
  });
});

const update_device_status = async_handler(async (req, res) => {
  const { device } = req.params;
  const { status } = req.body;
  const device_data = await device_service.update_device_status(device, status);
  res.status(200).json({
    success: true,
    data: device_data,
  });
});

const update_device = async_handler(async (req, res) => {
  const { device } = req.params;
  const update_fields = req.body;
  const device_data = await device_service.update_device(device, update_fields);
  res.status(200).json({
    success: true,
    data: device_data,
  });
});

const get_all_devices = async_handler(async (req, res) => {
  const { last_id, limit, search, status } = req.query;
  const result = await device_service.get_all_devices_cursor(last_id, limit, search, status);
  res.status(200).json({
    success: true,
    data: result.data,
    pagination: result.pagination,
    count: { active: result.total_active, inactive: result.total_inactive, total: result.total },
  });
});

const get_device_liting = async_handler(async (req, res) => {
  const { resident, type, home } = req.query;

  const device_data = await device_service.get_all_device_listng(req.user, resident, type, home);

  res.status(200).json({
    success: true,
    data: device_data,
  });
});

const create_token = async_handler(async (req, res) => {
  const { device } = req.params;
  const device_details = await device_service.get_device_by_id(device);
  // const get_resident = await get_resident_by_device(device_details._id);
  // if (!get_resident) {
  //   return res.status(404).json({
  //     success: false,
  //     message: 'Resident not attached to this device',
  //   });
  // }

  if (device_details.type != 'Emfit') {
    return res.status(400).json({
      success: false,
      message: 'Device type is not Emfit',
    });
  }
  const token_data = {
    device_id: device_details._id,
    device_type: device_details.type,
    sr_num: device_details.sr_num,
    // resident_id: get_resident._id,
    created_by: 'AWESOMLIVING_SYSTEM',
  };
  // generate token for unlimited time
  const token = generate_token(token_data, 0);
  res.status(200).json({
    success: true,
    data: {
      token,
      endpoint: '',
    },
  });
});
const signin_altum_device = async_handler(async (req, res) => {
  const { device_id } = req.params;
  const user_id = req.user;

  const result = await device_service.signin_altum_device(device_id, user_id);

  if (!result.success) {
    return res.status(400).json(result);
  }

  return res.status(200).json(result);
});
const update_device_mapping = async_handler(async (req, res) => {
  const { device_id } = req.params;
  const user_id = req.user;
  const { serial_number, firmware_version } = req.body;

  const result = await device_service.update_device_mapping(
    device_id,
    user_id,
    serial_number,
    firmware_version,
  );

  if (!result.success) {
    return res.status(400).json(result);
  }

  return res.status(200).json(result);
});
const create_altum_setup = async_handler(async (req, res) => {
  const { device_id } = req.params;

  const result = await device_service.create_altum_setup(device_id, req.user);

  if (!result.success) {
    return res.status(400).json(result);
  }

  return res.status(200).json(result);
});

// 🔹 preview image
const get_preview_image = async_handler(async (req, res) => {
  const { preview_token } = req.query;

  const result = await device_service.get_preview_image(
    req.params.device_id,
    req.user,
    preview_token,
  );

  return res.status(result.success ? 200 : 400).json(result);
});

// 🔹 calibrate camera
const calibrate_camera = async_handler(async (req, res) => {
  const result = await device_service.calibrate_camera(req.params.device_id, req.user);

  return res.status(result.success ? 200 : 400).json(result);
});

// 🔹 save background
const save_background = async_handler(async (req, res) => {
  const result = await device_service.save_background(req.params.device_id, req.user);

  return res.status(result.success ? 200 : 400).json(result);
});
// controllers/device.controller.js

const get_camera_status = async_handler(async (req, res) => {
  const result = await device_service.get_camera_status(req.params.device_id, req.user);
  res.status(result.success ? 200 : 400).json(result);
});

const get_background_url = async_handler(async (req, res) => {
  const result = await device_service.get_background_url(req.params.device_id, req.user);
  res.status(result.success ? 200 : 400).json(result);
});

const get_stream_token = async_handler(async (req, res) => {
  const result = await device_service.get_stream_token(req.params.device_id, req.user);
  res.status(result.success ? 200 : 400).json(result);
});

const get_mqtt_credentials = async_handler(async (req, res) => {
  const result = await device_service.get_mqtt_credentials(req.params.device_id, req.user);
  res.status(result.success ? 200 : 400).json(result);
});

const get_group_info = async_handler(async (req, res) => {
  const result = await device_service.get_group_info(req.params.device_id, req.user);
  res.status(result.success ? 200 : 400).json(result);
});
// ======================================================
// PERSON GROUPS
// ======================================================

const get_person_groups = async_handler(async (req, res) => {
  const { device_id } = req.params;
  const result = await device_service.get_person_groups(device_id, req.user);

  return res.status(result.success ? 200 : 400).json(result);
});

const create_person_group = async_handler(async (req, res) => {
  const { device_id } = req.params;
  const result = await device_service.create_person_group(device_id, req.body, req.user);
  return res.status(result.success ? 201 : 400).json(result);
});

const update_person_group = async_handler(async (req, res) => {
  const { device_id, group_id } = req.params;
  const result = await device_service.update_person_group(device_id, group_id, req.body, req.user);
  return res.status(result.success ? 200 : 400).json(result);
});
/* */
const delete_person_group = async_handler(async (req, res) => {
  const { device_id, group_id } = req.params;
  const result = await device_service.delete_person_group(device_id, group_id, req.user);

  return res.status(result.success ? 200 : 400).json(result);
});

// ======================================================
// PEOPLE
// ======================================================

const get_people = async_handler(async (req, res) => {
  const { device_id } = req.params;
  const result = await device_service.get_people(device_id, req.user);

  return res.status(result.success ? 200 : 400).json(result);
});

const create_person = async_handler(async (req, res) => {
  const { device_id } = req.params;
  const payload = {
    ...req.body,
    face_image: req.file?.buffer?.toString('base64') || null,
  };
  const result = await device_service.create_person(device_id, payload, req.user);

  return res.status(result.success ? 201 : 400).json(result);
});

const assign_person_group = async_handler(async (req, res) => {
  const { device_id, person_id } = req.params;
  const { group_id } = req.body;
  const result = await device_service.assign_person_group(device_id, person_id, group_id, req.user);

  return res.status(result.success ? 200 : 400).json(result);
});

const upload_person_face = async_handler(async (req, res) => {
  const { person_id, device_id } = req.params;
  const result = await device_service.upload_person_face(device_id, person_id, req.file, req.user);

  return res.status(result.success ? 200 : 400).json(result);
});

const delete_person = async_handler(async (req, res) => {
  const { person_id, device_id } = req.params;
  const result = await device_service.delete_person(device_id, person_id, req.user);

  return res.status(result.success ? 200 : 400).json(result);
});
const update_person = async_handler(async (req, res) => {
  const { device_id, person_id } = req.params;

  const result = await device_service.update_person(device_id, person_id, req.body, req.user);

  return res.status(result.success ? 200 : 400).json(result);
});
// ── Helpers for Zigbee alert_log queries ─────────────────────────────────────

const _get_zigbee_resident = async (device_id, user_id) => {
  const device = await device_model
    .findOne({ _id: device_id, type: 'Zigbee', status: 'active' })
    .lean();
  if (!device) return { ok: false, msg: 'Zigbee device not found' };

  // Resident-mapped devices have device.resident set directly (GLK path).
  // Home-mapped devices (Zigbee, CpPlus) have device.home instead — look
  // up the resident through the home so alerts work for emergency buttons,
  // contact sensors, and motion sensors mapped via home_id.
  let resident = null;
  if (device.resident) {
    resident = await resident_model.findOne({ _id: device.resident, creator: user_id }).lean();
  } else if (device.home) {
    resident = await resident_model.findOne({ home: device.home, creator: user_id }).lean();
  }
  if (!resident) return { ok: false, msg: 'Unauthorized device access' };
  // Attach resident _id on device so callers (get_alert_by_id, resolve_alert)
  // can use it for authorization without a second lookup.
  device.resident = resident._id;
  return { ok: true, device };
};

// When a device belongs to an occupancy group, alerts may be stored against
// any of the group's member devices (room_motion_device, threshold_device,
// door_device).  This helper returns the list of device ids to query so
// listing / resolving covers the entire group.
const _get_occupancy_group_device_ids = async (device) => {
  if (!device.occupancy_group) return [device._id];

  const group_devices = await device_model
    .find({
      occupancy_group: device.occupancy_group,
      type: 'Zigbee',
      $or: [
        { resident: device.resident },
        { home: device.home },
      ],
    })
    .select('_id')
    .lean();

  const ids = group_devices.map((d) => d._id);
  // Always include the queried device itself (safety net)
  if (!ids.find((id) => id.toString() === device._id.toString())) {
    ids.push(device._id);
  }
  return ids;
};

const get_alerts = async_handler(async (req, res) => {
  const { device_id } = req.params;

  const device = await device_model.findById(device_id).lean();
  if (!device) return res.status(404).json({ success: false, message: 'Device not found' });

  // Zigbee → read from local alert_log collection
  if (device.type === 'Zigbee') {
    const check = await _get_zigbee_resident(device_id, req.user);
    if (!check.ok) return res.status(400).json({ success: false, message: check.msg });

    // Query by resident + device_type so ALL occupancy alerts are returned
    // regardless of which device they were stored against. The occupancy
    // alert checker assigns the device field from whichever reference is
    // populated first on the room_occupancy_state (room_motion_device /
    // threshold / door), and motion sensors are mapped via home — not
    // resident — so a device-only filter can miss alerts when the passed
    // device_id doesn't match the stored device reference.
    const filter = { resident: check.device.resident, device_type: 'zigbee' };
    if (req.query.is_resolved === 'true') filter.is_resolved = true;
    if (req.query.is_resolved === 'false') filter.is_resolved = false;

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
    const skip = (page - 1) * limit;

    const alerts = await alert_log
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    return res.status(200).json({ success: true, data: alerts });
  }

  // Eltum camera → existing Altum API path
  const result = await device_service.get_alerts(device_id, req.query, req.user);
  res.status(200).json(result);
});

// GET alert by id
const get_alert_by_id = async_handler(async (req, res) => {
  const { device_id, alert_id } = req.params;

  const device = await device_model.findById(device_id).lean();
  if (!device) return res.status(404).json({ success: false, message: 'Device not found' });

  if (device.type === 'Zigbee') {
    const check = await _get_zigbee_resident(device_id, req.user);
    if (!check.ok) return res.status(400).json({ success: false, message: check.msg });

    // Look up by alert_id alone rather than requiring device_id to match the
    // alert's own `device` field: the app can reference a different sensor on
    // the same resident (e.g. a stale/incorrect device_id in a push payload)
    // while still legitimately pointing at this alert. Authorize against the
    // alert's own resident instead of a literal device match.
    const log = await alert_log.findById(alert_id).lean();
    if (!log || log.resident.toString() !== check.device.resident.toString()) {
      return res.status(404).json({ success: false, message: 'Alert not found' });
    }
    return res.status(200).json({ success: true, data: log });
  }

  const result = await device_service.get_alert_by_id(device_id, alert_id, req.user);
  res.status(200).json(result);
});

// PATCH alert — resolve
const resolve_alert = async_handler(async (req, res) => {
  const { device_id, alert_id } = req.params;

  const device = await device_model.findById(device_id).lean();
  if (!device) return res.status(404).json({ success: false, message: 'Device not found' });

  if (device.type === 'Zigbee') {
    const check = await _get_zigbee_resident(device_id, req.user);
    if (!check.ok) return res.status(400).json({ success: false, message: check.msg });

    // Match by alert_id alone -- see get_alert_by_id above for why the URL's
    // device_id isn't required to equal the alert's own `device` field.
    const alert = await alert_log.findById(alert_id).lean();
    if (!alert || alert.resident.toString() !== check.device.resident.toString()) {
      return res.status(404).json({ success: false, message: 'Alert not found' });
    }

    const updated = await alert_log.findOneAndUpdate(
      { _id: alert_id },
      { is_resolved: true, resolved_at: new Date() },
      { new: true },
    );
    return res.status(200).json({ success: true, data: updated });
  }

  const result = await device_service.resolve_alert(device_id, alert_id, req.body, req.user);
  res.status(result.success ? 200 : 400).json(result);
});

// PATCH all — resolve all
const resolve_all_alerts = async_handler(async (req, res) => {
  const { device_id } = req.params;

  const device = await device_model.findById(device_id).lean();
  if (!device) return res.status(404).json({ success: false, message: 'Device not found' });

  if (device.type === 'Zigbee') {
    const check = await _get_zigbee_resident(device_id, req.user);
    if (!check.ok) return res.status(400).json({ success: false, message: check.msg });

    // Resolve by resident so every Zigbee alert is covered — same rationale
    // as get_alerts: device-only filter can miss alerts when the motion
    // sensor is home-mapped and the stored device reference differs.
    const update_result = await alert_log.updateMany(
      { resident: check.device.resident, device_type: 'zigbee', is_resolved: false },
      { is_resolved: true, resolved_at: new Date() },
    );
    return res.status(200).json({
      success: true,
      message: 'All alerts resolved',
      resolved_count: update_result.modifiedCount || 0,
    });
  }

  const result = await device_service.resolve_all_alerts(device_id, req.user);
  res.status(200).json(result);
});
const get_alert_settings = async_handler(async (req, res) => {
  const { device_id, camera_id } = req.params;

  const result = await device_service.get_alert_settings(device_id, camera_id, req.user);

  return res.status(200).json(result);
});

// PATCH
const update_alert_settings = async_handler(async (req, res) => {
  const { device_id, camera_id } = req.params;

  const result = await device_service.update_alert_settings(
    device_id,
    camera_id,
    req.body,
    req.user,
  );

  return res.status(result.success ? 200 : 400).json(result);
});
const watch_cpplus = async_handler(async (req, res) => {
  const device = await device_service.get_device_by_id(req.params.device);
  if (!device || device.type !== 'CpPlus') {
    return res.status(404).json({ success: false, message: 'CpPlus device not found' });
  }
  // Pass resident ID as fallback for stream URL resolution — covers the
  // window before hub_id is stamped on the device by the Pi's heartbeat.
  const resident_id = device.resident?._id || device.resident;
  const urls = await device_service.get_cpplus_stream_url(
    device.stream_name,
    device.hub_id,
    resident_id,
  );
  res.json({ success: true, data: { stream_name: device.stream_name, ...urls } });
});

const get_alert_analytics = async_handler(async (req, res) => {
  const { device_id } = req.params;

  const result = await device_service.get_alert_analytics(device_id, req.query, req.user);

  res.status(200).json(result);
});
// ── Contact Alert Settings ────────────────────────────────────────────────────

/**
 * PATCH /api/user/devices/:device_id/no-motion-threshold
 * Body: { threshold_min: 30 }
 * Sets only the initial alert time (minutes of no motion before the first alert fires).
 * The repeat interval (every 5 min after first alert) is fixed and unchanged.
 */
const set_no_motion_threshold = async_handler(async (req, res) => {
  const { device_id } = req.params;
  const { threshold_min } = req.body;

  if (threshold_min === undefined || typeof threshold_min !== 'number' || threshold_min < 1) {
    return res.status(400).json({
      success: false,
      message: 'threshold_min is required and must be a positive number (minutes)',
    });
  }

  const result = await zigbee_settings_service.set_no_motion_threshold(device_id, threshold_min);
  return res.status(result.success ? 200 : result.status || 400).json(result);
});

/**
 * GET /api/user/devices/:device_id/no-motion-settings
 * Returns no-motion alert config for a presence sensor device.
 */
const get_no_motion_settings = async_handler(async (req, res) => {
  const { device_id } = req.params;
  const result = await zigbee_settings_service.get_no_motion_settings(device_id);
  return res.status(result.success ? 200 : result.status || 400).json(result);
});

/**
 * PATCH /api/user/devices/:device_id/no-motion-settings
 * Body: { threshold_min, escalation_delay_min, night_mode_enabled, night_threshold_min, night_from, night_to, is_active }
 */
const update_no_motion_settings = async_handler(async (req, res) => {
  const { device_id } = req.params;
  const {
    threshold_min,
    escalation_delay_min,
    night_mode_enabled,
    night_threshold_min,
    night_from,
    night_to,
    is_active,
  } = req.body;

  const time_re = /^([01]\d|2[0-3]):([0-5]\d)$/;
  if (night_from && !time_re.test(night_from)) {
    return res.status(400).json({ success: false, message: 'night_from must be HH:MM (24-hr)' });
  }
  if (night_to && !time_re.test(night_to)) {
    return res.status(400).json({ success: false, message: 'night_to must be HH:MM (24-hr)' });
  }

  const update = {};
  if (threshold_min !== undefined) update.threshold_min = threshold_min;
  if (escalation_delay_min !== undefined) update.escalation_delay_min = escalation_delay_min;
  if (night_mode_enabled !== undefined) update.night_mode_enabled = night_mode_enabled;
  if (night_threshold_min !== undefined) update.night_threshold_min = night_threshold_min;
  if (night_from !== undefined) update.night_from = night_from;
  if (night_to !== undefined) update.night_to = night_to;
  if (is_active !== undefined) update.is_active = is_active;

  const result = await zigbee_settings_service.update_no_motion_settings(device_id, update);
  return res.status(result.success ? 200 : result.status || 400).json(result);
});

/**
 * GET /api/user/devices/:device_id/room-state
 * Returns the current combined motion+presence state for the room this device belongs to.
 */
const get_device_room_state = async_handler(async (req, res) => {
  const { device_id } = req.params;
  const result = await zigbee_settings_service.get_room_state(device_id);
  return res.status(result.success ? 200 : result.status || 400).json(result);
});

/**
 * GET /api/user/devices/:device_id/no-motion-alerts
 * Returns the latest N alert logs for the room this device belongs to.
 * Accepts either the motion or presence sensor device ID — both resolve to the same room.
 * Covers old "Bathroom Occupancy Alert" (motion device) + new no-motion alerts (presence device).
 * Supports ?limit=N (max 50, default 10).
 */
const get_no_motion_alert_history = async_handler(async (req, res) => {
  const { device_id } = req.params;
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
  const result = await zigbee_settings_service.get_no_motion_alert_history(device_id, limit);
  return res.status(result.success ? 200 : result.status || 400).json(result);
});

/**
 * GET /api/user/devices/:device_id/contact-settings
 * Returns the monitoring time window for a Zigbee contact device.
 */
const get_contact_alert_settings = async_handler(async (req, res) => {
  const { device_id } = req.params;
  const result = await zigbee_settings_service.get_contact_settings(device_id);
  return res.status(result.success ? 200 : result.status || 400).json(result);
});

/**
 * PATCH /api/user/devices/:device_id/contact-settings
 * Body: { monitor_from, monitor_to, is_active }
 * Creates or updates the monitoring time window for a Zigbee contact device.
 */
const update_contact_alert_settings = async_handler(async (req, res) => {
  const { device_id } = req.params;
  const { monitor_from, monitor_to, is_active } = req.body;

  const time_re = /^([01]\d|2[0-3]):([0-5]\d)$/;
  if (monitor_from && !time_re.test(monitor_from)) {
    return res.status(400).json({ success: false, message: 'monitor_from must be HH:MM (24-hr)' });
  }
  if (monitor_to && !time_re.test(monitor_to)) {
    return res.status(400).json({ success: false, message: 'monitor_to must be HH:MM (24-hr)' });
  }

  const update = {};
  if (monitor_from !== undefined) update.monitor_from = monitor_from;
  if (monitor_to !== undefined) update.monitor_to = monitor_to;
  if (is_active !== undefined) update.is_active = is_active;

  const result = await zigbee_settings_service.update_contact_settings(device_id, update);
  return res.status(result.success ? 200 : result.status || 400).json(result);
});

// ── Setup recovery (rollback) & calibration verification ─────────────────────
const rollback_device_setup = async_handler(async (req, res) => {
  const result = await rollback_altum_setup(req.params.device_id, req.user._id);
  return res.status(result.success ? 200 : 400).json(result);
});

const verify_device_calibration = async_handler(async (req, res) => {
  const result = await verify_calibration_readiness(req.params.device_id, req.user._id);
  return res.status(result.success ? 200 : 400).json(result);
});

// ── Occupancy v4 endpoints ──────────────────────────────────────────────────

/**
 * GET /api/user/devices/:device_id/room-state-v4
 * Returns the v4 occupancy state for the room this device belongs to.
 * device_id must be a Zigbee sensor with sensor_role 'doorway' or 'inside'.
 */
const get_v4_room_state_handler = async_handler(async (req, res) => {
  const device = await device_model.findById(req.params.device_id).lean();
  if (!device || device.type !== 'Zigbee' || !device.occupancy_group) {
    return res.status(400).json({ success: false, message: 'device_not_v4_occupancy' });
  }

  const resident_id = device.resident;
  if (!resident_id) {
    // Resolve resident from home
    const resident_doc = await resident_model.findOne({ home: device.home }).select('_id').lean();
    if (!resident_doc) {
      return res.status(400).json({ success: false, message: 'resident_not_found' });
    }
    const state = await get_v4_room_state(resident_doc._id, device.occupancy_group);
    return res.json({ success: true, data: state });
  }

  const state = await get_v4_room_state(resident_id, device.occupancy_group);
  return res.json({ success: true, data: state });
});

/**
 * POST /api/user/devices/:device_id/acknowledge-v4
 * Acknowledges the current v4 alert for the room this device belongs to.
 */
const acknowledge_v4_alert_handler = async_handler(async (req, res) => {
  const device = await device_model.findById(req.params.device_id).lean();
  if (!device || device.type !== 'Zigbee' || !device.occupancy_group) {
    return res.status(400).json({ success: false, message: 'device_not_v4_occupancy' });
  }

  let resident_id = device.resident;
  if (!resident_id) {
    const resident_doc = await resident_model.findOne({ home: device.home }).select('_id').lean();
    if (!resident_doc) {
      return res.status(400).json({ success: false, message: 'resident_not_found' });
    }
    resident_id = resident_doc._id;
  }

  const user_id = req.user._id.toString();
  const ok = await acknowledge_v4_alert(resident_id, device.occupancy_group, user_id);
  return res.json({ success: ok, message: ok ? 'acknowledged' : 'no_active_alert' });
});

/**
 * POST /api/user/devices/:device_id/away-v4
 * Body: { away: true|false }
 * Toggles away mode for the v4 occupancy room this device belongs to.
 */
const set_v4_away_handler = async_handler(async (req, res) => {
  const device = await device_model.findById(req.params.device_id).lean();
  if (!device || device.type !== 'Zigbee' || !device.occupancy_group) {
    return res.status(400).json({ success: false, message: 'device_not_v4_occupancy' });
  }

  const { away } = req.body;
  if (typeof away !== 'boolean') {
    return res.status(400).json({ success: false, message: 'away must be boolean' });
  }

  let resident_id = device.resident;
  if (!resident_id) {
    const resident_doc = await resident_model.findOne({ home: device.home }).select('_id').lean();
    if (!resident_doc) {
      return res.status(400).json({ success: false, message: 'resident_not_found' });
    }
    resident_id = resident_doc._id;
  }

  await set_v4_away(resident_id, device.occupancy_group, away, {
    resident_id,
    occupancy_group: device.occupancy_group,
  });
  return res.json({ success: true, away });
});

export {
  create_device,
  get_device,
  update_device_status,
  update_device,
  get_all_devices,
  get_device_liting,
  create_token,
  is_device_already_mapped_to_resident,
  is_device_online,
  signin_altum_device,
  update_device_mapping,
  create_altum_setup,
  get_preview_image,
  calibrate_camera,
  save_background,
  get_camera_status,
  get_background_url,
  get_stream_token,
  get_mqtt_credentials,
  get_group_info,
  get_person_groups,
  create_person_group,
  update_person_group,
  delete_person_group,
  get_people,
  create_person,
  assign_person_group,
  upload_person_face,
  delete_person,
  update_person,
  get_v4_room_state_handler,
  acknowledge_v4_alert_handler,
  set_v4_away_handler,
  get_alerts,
  get_alert_by_id,
  resolve_alert,
  resolve_all_alerts,
  get_alert_settings,
  update_alert_settings,
  watch_cpplus,
  get_alert_analytics,
  delete_device,
  get_contact_alert_settings,
  update_contact_alert_settings,
  get_no_motion_settings,
  update_no_motion_settings,
  get_device_room_state,
  set_no_motion_threshold,
  get_no_motion_alert_history,
  rollback_device_setup,
  verify_device_calibration,
};
