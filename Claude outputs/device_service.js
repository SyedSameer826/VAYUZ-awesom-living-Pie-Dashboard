import { request } from 'http';
import device_model from '../models/device.js';
import resident_model from '../models/resident.js';
import home_model from '../models/home.js';
import mongoose from 'mongoose';
import unknown_route_log from '../models/unknown_routelog.js';
import zigbee_log from '../models/zigbee_log.js';
import alert_log from '../models/alert_log.js';
import alert_state from '../models/alert_state.js';
import contact_alert_settings from '../models/contact_alert_settings.js';
import { altum_request } from '../middleware/Eltum/requestWrapper.js';
import { get_altum_token } from '../middleware/Eltum/tokenManager.js';
import { device_id_validator } from '../helper/validator.js';
import FormData from 'form-data';
import { URLSearchParams } from 'url';
import { eltum_event_types } from '../config/month_name.js';
import { to_object_id } from '../helper/index.js';
import { normalize_sensor_type } from '../helper/device_category.js';
import hub_status_model from '../models/hub_status.js';

// Fallback go2rtc URL — used only when the camera's hub has no tunnel_url yet
// (e.g. single-Pi setups that haven't started reporting their tunnel).
const go_2_rtc_url_fallback = process.env.GO2RTC_URL || 'http://192.168.1.50:1984';

const get_device_details = async (device) => await device_model.findOne(device);
const get_devices = (device) => device_model.find(device);
const get_any_device_by_id = (device) => device_model.findById(device);

/**
 * Resolve the WebRTC + HLS stream URLs for a CpPlus camera.
 * For multi-hub setups each Pi has its own go2rtc behind its own Cloudflare
 * tunnel — we look up the camera's hub_id → hub_status.tunnel_url to build
 * the correct URL. Falls back to the env / default for single-Pi setups.
 *
 * Resolution order:
 *   1. hub_id → hub_status.tunnel_url  (preferred — direct device binding)
 *   2. resident → hub_status.tunnel_url (fallback — when hub_id hasn't been
 *      set on the device yet, find any online hub that manages this resident)
 *   3. go2rtc env / hardcoded default   (last resort — single-Pi / dev mode)
 *
 * @param {string} stream_name   - the camera's stream name in go2rtc
 * @param {string} [hub_id]      - optional hub_id from the CpPlus device
 * @param {string} [resident_id] - optional resident ObjectId for fallback lookup
 * @returns {Promise<{webrtc: string, hls: string}>}
 */
const get_cpplus_stream_url = async (stream_name, hub_id, resident_id) => {
  let base_url = go_2_rtc_url_fallback;
  let resolved_via = 'fallback';

  // 1. Direct lookup by hub_id (the camera knows which Pi manages it).
  if (hub_id) {
    const hub = await hub_status_model.findOne({ hub_id }).select('tunnel_url').lean();
    if (hub?.tunnel_url) {
      base_url = hub.tunnel_url;
      resolved_via = 'hub_id';
    }
  }

  // 2. Fallback: find any online hub bound to this camera's resident.
  //    Covers the window between device creation and the first heartbeat
  //    that stamps hub_id on the CpPlus device document.
  if (resolved_via === 'fallback' && resident_id) {
    const hub = await hub_status_model
      .findOne({ resident: resident_id, online: true })
      .select('tunnel_url hub_id')
      .lean();
    if (hub?.tunnel_url) {
      base_url = hub.tunnel_url;
      resolved_via = 'resident';
      // Back-fill hub_id on the device so subsequent calls take the fast path.
      // Fire-and-forget — a failure here is harmless.
      if (hub.hub_id) {
        device_model
          .updateOne(
            { type: 'CpPlus', stream_name, hub_id: { $in: [null, undefined, ''] } },
            { $set: { hub_id: hub.hub_id } },
          )
          .catch(() => {});
      }
    }
  }

  console.log(`[stream-url] ${stream_name}: resolved via ${resolved_via} → ${base_url}`);

  return {
    webrtc: `${base_url}/api/webrtc?src=${stream_name}`,
    hls: `${base_url}/api/stream.m3u8?src=${stream_name}`,
  };
};
const delete_device = async (device) => {
  // Only delete the device document itself — historical data (zigbee_logs,
  // alert_log, alert_state, contact_alert_settings) is intentionally
  // preserved so analytics / AI features can still reference past events.
  if (device.type === 'CpPlus' && device.stream_name) {
    // Remove the camera device doc (and any duplicates from before the
    // map-dedupe fix), but leave stream recordings / logs intact.
    await device_model.deleteMany({
      type: 'CpPlus',
      stream_name: device.stream_name,
    });
    return;
  }
  await device_model.findByIdAndDelete(device._id);
};
const is_emfit_exist = async (serial_no) =>
  await device_model.exists({ sr_num: serial_no, type: 'Emfit' });
const create_device = async (
  type,
  device_id,
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
) => {
  // Auto-resolve home from resident if not explicitly provided.
  if (!home && resident) {
    try {
      const res = await resident_model.findById(resident).select('home').lean();
      if (res?.home) home = res.home;
    } catch {
      // Non-fatal — device will simply have home: null.
    }
  }

  const payload = {
    type,
    sr_num,
    client_id,
    client_secret,
    ...(resident && { resident }),
    ...(home && { home }),
  };

  // 🔥 existing behavior (Eltum)
  if (type === 'Eltum') {
    payload.camera_id = device_id;
  }

  // 🔥 Zigbee support (NEW)
  if (type === 'Zigbee') {
    payload.id = id || device_id;
    payload.ieee = ieee;
    payload.sensor_type = sensor_type;
    payload.room = room || 'bathroom';
    if (paired_motion_ieee) payload.paired_motion_ieee = paired_motion_ieee;
    if (paired_window_ieee) payload.paired_window_ieee = paired_window_ieee;
    if (occupancy_group) payload.occupancy_group = occupancy_group;
    if (sensor_role) payload.sensor_role = sensor_role;

    // Dedupe: if a Zigbee device with the same ieee already exists for this
    // home (or resident), update it instead of creating a duplicate. This
    // covers re-saves from the Pi dashboard that set/change pairing fields.
    const zigbee_dedupe = { type: 'Zigbee', ieee };
    if (home) zigbee_dedupe.home = home;
    else if (resident) zigbee_dedupe.resident = resident;
    const existing_zigbee = await device_model.findOne(zigbee_dedupe);
    if (existing_zigbee) {
      existing_zigbee.id = payload.id;
      existing_zigbee.sensor_type = payload.sensor_type;
      existing_zigbee.room = payload.room;
      existing_zigbee.status = 'active';
      existing_zigbee.paired_motion_ieee = paired_motion_ieee || null;
      existing_zigbee.paired_window_ieee = paired_window_ieee || null;
      existing_zigbee.occupancy_group = occupancy_group || null;
      existing_zigbee.sensor_role = sensor_role || null;
      if (home) existing_zigbee.home = home;
      await existing_zigbee.save();
      return existing_zigbee;
    }
  }
  // after the existing Zigbee block
  if (type === 'CpPlus') {
    payload.stream_name = stream_name;
    payload.local_ip = local_ip;
    payload.room = room || 'living_room';
    if (hub_id) payload.hub_id = hub_id;
    if (rtsp_url) payload.rtsp_url = rtsp_url;

    // Dedupe: if this camera (same stream_name) is already mapped to this
    // home (or resident for legacy flows), update instead of duplicating.
    const dedupe_query = { type: 'CpPlus', stream_name };
    if (home) dedupe_query.home = home;
    else if (resident) dedupe_query.resident = resident;
    const existing = await device_model.findOne(dedupe_query);
    if (existing) {
      existing.local_ip = payload.local_ip;
      existing.room = payload.room;
      existing.status = 'active';
      if (hub_id) existing.hub_id = hub_id;
      if (rtsp_url) existing.rtsp_url = rtsp_url;
      if (home) existing.home = home;
      await existing.save();
      return existing;
    }
  }

  // BpMonitor — paired via BLE MAC address from Pi
  if (type === 'BpMonitor') {
    payload.mac_address = mac_address;

    // Dedupe: if this MAC is already mapped to this resident, reactivate it
    const existing = await device_model.findOne({
      type: 'BpMonitor',
      resident,
      mac_address,
    });
    if (existing) {
      existing.status = 'active';
      if (sr_num) existing.sr_num = sr_num;
      await existing.save();
      return existing;
    }
  }
  return await device_model.create(payload);
};
const is_device_online = async (serial_no) => {
  const sixty_minutes_ago = new Date(Date.now() - 60 * 60 * 1000);

  // 1. Try unknown_route_log first (handles Emfit, GLK, BpMonitor, etc.)
  const last_log = await unknown_route_log
    .findOne({ 'body.serialnumber': serial_no })
    .sort({ createdAt: -1 });

  if (last_log) {
    const is_online = last_log.createdAt >= sixty_minutes_ago;
    return { online: is_online, last_seen: last_log.createdAt };
  }

  // 2. No match in unknown_route_log — check if this is a Zigbee device.
  //    Zigbee events are stored in zigbee_log (collection zigbeeDevices),
  //    keyed by device_name (= device.id, the friendly name from Zigbee2MQTT).
  const zigbee_device = await device_model
    .findOne({
      type: 'Zigbee',
      status: 'active',
      $or: [{ ieee: serial_no }, { id: serial_no }],
    })
    .select('id')
    .lean();

  if (zigbee_device) {
    const zigbee_last = await zigbee_log
      .findOne({ device_name: zigbee_device.id })
      .sort({ createdAt: -1 })
      .select('createdAt')
      .lean();

    const is_online = zigbee_last && zigbee_last.createdAt >= sixty_minutes_ago;
    return {
      online: !!is_online,
      last_seen: zigbee_last ? zigbee_last.createdAt : null,
    };
  }

  return { online: false, last_seen: null };
};
const get_device_by_id = async (device_id) => {
  return await get_any_device_by_id(device_id)
    .populate({
      path: 'home',
      select: '_id name',
    })
    .populate({
      path: 'resident',
      select: '_id name',
    })
    .lean();
};
const check_device = async (serial_no) => {
  if (!serial_no) {
    return { exists: false, message: 'Please enter serial no.' };
  }

  const device = await get_device_details({ sr_num: serial_no, type: 'Emfit' }).lean();

  if (device) {
    return {
      exists: true,
      message: 'This Emfit device is already registered with some other Resident',
    };
  }

  return {
    exists: false,
    message: 'Device not found',
  };
};

const update_device_status = async (device_id, status) => {
  return await device_model.findByIdAndUpdate(device_id, { status }, { new: true }).lean();
};

const update_device = async (device_id, update_fields) => {
  return await device_model
    .findOneAndUpdate({ _id: device_id }, update_fields, {
      new: true,
      overwriteDiscriminatorKey: true,
    })
    .lean();
};

const get_all_devices_cursor = async (last_id = null, limit = 10, search = '', status = '') => {
  const limit_num = Math.min(100, Math.max(1, parseInt(limit, 10)));

  /* ---------- SEARCH CONDITION ---------- */
  const search_condition =
    search && search.trim()
      ? {
          $or: [
            { type: { $regex: search, $options: 'i' } },
            { sr_num: { $regex: search, $options: 'i' } },
            { 'resident.name': { $regex: search, $options: 'i' } },
            { 'resident.user.first_name': { $regex: search, $options: 'i' } },
            { 'resident.user.last_name': { $regex: search, $options: 'i' } },
          ],
        }
      : {};

  /* ---------- BASE MATCH (FOR COUNTS) ---------- */
  const base_match = {
    ...search_condition,
    ...(status?.trim() && { status: new RegExp(`^${status}$`, 'i') }),
  };

  /* ---------- PAGINATION MATCH (DATA ONLY) ---------- */
  const pagination_match = {
    ...base_match,
    ...(last_id && { _id: { $lt: to_object_id(last_id) } }),
  };

  const result = await device_model.aggregate([
    {
      $facet: {
        /* ---------- PAGINATED DEVICES ---------- */
        devices: [
          { $match: pagination_match },
          { $sort: { _id: -1 } },
          { $limit: limit_num + 1 },
          {
            $lookup: {
              from: 'residents',
              let: { resident_id: '$resident' },
              pipeline: [
                { $match: { $expr: { $eq: ['$_id', '$$resident_id'] } } },
                {
                  $lookup: {
                    from: 'users',
                    let: { user: '$creator' },
                    pipeline: [
                      { $match: { $expr: { $eq: ['$_id', '$$user'] } } },
                      { $project: { first_name: 1, last_name: 1 } },
                    ],
                    as: 'user',
                  },
                },
                { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
                { $project: { _id: 1, name: 1, user: 1 } },
              ],
              as: 'resident',
            },
          },
          { $unwind: { path: '$resident', preserveNullAndEmptyArrays: true } },
          /* ---------- HOME LOOKUP ---------- */
          {
            $lookup: {
              from: 'homes',
              localField: 'home',
              foreignField: '_id',
              pipeline: [{ $project: { _id: 1, name: 1 } }],
              as: 'home',
            },
          },
          { $unwind: { path: '$home', preserveNullAndEmptyArrays: true } },
        ],

        /* ---------- STATUS COUNTS (NO PAGINATION) ---------- */
        status_counts: [{ $match: base_match }, { $group: { _id: '$status', count: { $sum: 1 } } }],
      },
    },
  ]);

  const devices = result[0]?.devices || [];
  const status_counts = result[0]?.status_counts || [];

  const has_next_page = devices.length > limit_num;
  const data = has_next_page ? devices.slice(0, limit_num) : devices;
  const next_cursor = data.length ? data[data.length - 1]._id.toString() : null;

  const total_active = status_counts.find((s) => s._id?.toLowerCase() === 'active')?.count || 0;
  const total_inactive = status_counts.find((s) => s._id?.toLowerCase() === 'inactive')?.count || 0;

  return {
    data,
    pagination: {
      next_cursor,
      has_next_page,
      records_per_page: limit_num,
    },
    total_active,
    total_inactive,
    total: total_active + total_inactive,
  };
};
const get_all_device_listng = async (user_id, resident, type, home) => {
  let filter = { status: 'active' };

  // 👤 resident / home filter — devices may belong to a resident OR directly
  // to a home (Zigbee & CpPlus mapped via the Pi hub).  Build an $or so both
  // ownership paths surface the correct devices for this user.
  if (resident) {
    filter.resident = resident;
  } else if (home) {
    // Specific home requested — return devices belonging to this home OR to
    // residents of this home.
    const home_residents = await resident_model.find({ home }).select('_id').lean();
    const home_resident_ids = home_residents.map((r) => r._id);

    filter.$or = [
      { home },
      ...(home_resident_ids.length ? [{ resident: { $in: home_resident_ids } }] : []),
    ];
  } else {
    const [residents, homes] = await Promise.all([
      resident_model.find({ creator: user_id }).select('_id').lean(),
      home_model.find({ user_id }).select('_id').lean(),
    ]);
    const resident_ids = residents.map((r) => r._id);
    const home_ids = homes.map((h) => h._id);

    filter.$or = [
      { resident: { $in: resident_ids } },
      ...(home_ids.length ? [{ home: { $in: home_ids } }] : []),
    ];
  }

  // 📌 optional type filter
  if (type) {
    filter.type = type;
  }

  const devices = await device_model
    .find(filter)
    .select(
      '_id type device_id sr_num resident home device_status client_id client_secret id ieee sensor_type room stream_name local_ip hub_id rtsp_url occupancy_group sensor_role paired_motion_ieee paired_window_ieee',
    )
    .populate({ path: 'home', select: '_id name' })
    .populate({ path: 'resident', select: '_id name' })
    .lean();

  if (!devices.length) return [];

  // ── Hide paired child sensors from the user-facing listing ──────────────
  // In a motion-sensor setup, the master motion sensor has paired_window_ieee
  // (pointing to a contact sensor) and paired_motion_ieee (pointing to a
  // secondary motion sensor).  Those child devices should not appear as
  // separate entries — only the master motion sensor shows.
  // Standalone contact sensors (not paired) remain visible even if they
  // carry occupancy_group / sensor_role tags for the occupancy state machine.
  const motion_sensors = devices.filter(
    (d) => d.type === 'Zigbee' && normalize_sensor_type(d.sensor_type) === 'motion',
  );

  const paired_contact_ieees = new Set(
    motion_sensors.filter((d) => d.paired_window_ieee).map((d) => d.paired_window_ieee),
  );

  const paired_motion_ieees = new Set(
    motion_sensors.filter((d) => d.paired_motion_ieee).map((d) => d.paired_motion_ieee),
  );

  // ── v4 occupancy: hide 'inside' sensors, only show 'doorway' ────────────
  // Collect occupancy_groups that have a doorway sensor — any 'inside' sensor
  // in those groups is a companion and should not appear separately.
  const v4_doorway_groups = new Set(
    devices
      .filter((d) => d.type === 'Zigbee' && d.sensor_role === 'doorway' && d.occupancy_group)
      .map((d) => d.occupancy_group),
  );

  const visible_devices = devices.filter((d) => {
    if (d.type !== 'Zigbee') return true;
    const norm_type = normalize_sensor_type(d.sensor_type);
    // Hide contact sensors that are part of a motion-sensor setup
    if (norm_type === 'contact' && paired_contact_ieees.has(d.ieee)) return false;
    // Hide secondary motion sensors (only the master shows) — v3
    if (norm_type === 'motion' && paired_motion_ieees.has(d.ieee)) return false;
    // Hide v4 'inside' companion sensors — only 'doorway' is user-facing
    if (d.sensor_role === 'inside' && v4_doorway_groups.has(d.occupancy_group)) return false;
    return true;
  });

  // ---------------- EMFIT LOGIC ---------------- //

  const one_hour_ago = new Date(Date.now() - 60 * 60 * 1000);

  const emfit_devices = visible_devices.filter((d) => d.type?.toLowerCase() === 'emfit');

  const serial_numbers = emfit_devices.map((d) => d.sr_num);

  const logs = await unknown_route_log.aggregate(
    [
      { $match: { 'body.serialnumber': { $in: serial_numbers } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$body.serialnumber',
          last_seen: { $first: '$createdAt' },
        },
      },
    ],
    // Emfit devices log frequently, so even a serial-filtered sort can be large.
    { allowDiskUse: true },
  );

  const log_map = {};
  logs.forEach((log) => {
    log_map[log._id] = log.last_seen;
  });

  // ---------------- ZIGBEE ONLINE STATUS ---------------- //
  // Zigbee events are stored in zigbee_log (collection zigbeeDevices), not in
  // unknown_route_log. Batch-query the latest event per device_name so the
  // listing can report online/offline for door, motion, presence, and switch
  // sensors the same way it does for Emfit devices above.

  const zigbee_visible = visible_devices.filter((d) => d.type?.toLowerCase() === 'zigbee');
  const zigbee_device_names = zigbee_visible.map((d) => d.id).filter(Boolean);

  const zigbee_online_logs = zigbee_device_names.length
    ? await zigbee_log.aggregate(
        [
          { $match: { device_name: { $in: zigbee_device_names } } },
          { $sort: { createdAt: -1 } },
          { $group: { _id: '$device_name', last_seen: { $first: '$createdAt' } } },
        ],
        { allowDiskUse: true },
      )
    : [];

  const zigbee_log_map = {};
  zigbee_online_logs.forEach((log) => {
    zigbee_log_map[log._id] = log.last_seen;
  });

  // ---------------- FINAL MERGED RESPONSE ---------------- //
  const final = await Promise.all(
    visible_devices.map(async (device) => {
      const type_normalized = device.type?.toLowerCase();

      if (type_normalized === 'emfit') {
        const last_seen = log_map[device.sr_num] || null;
        const online = last_seen ? last_seen >= one_hour_ago : false;

        return {
          ...device,
          status: online ? 'online' : 'offline',
          last_seen,
        };
      }

      if (type_normalized === 'eltum') {
        let status = 'mapped';

        if (
          ['USER_SIGNIN_DONE', 'CALIBRATION_DONE', 'STREAMING_DONE', 'ACTIVE'].includes(
            device.device_status,
          )
        ) {
          status = 'logged_in';
        }
        if (!device?.sr_num) {
          status = 'unmapped';
          return {
            _id: device._id,
            type: device.type,
            resident: device.resident,
            status,
            last_seen: null,
          };
        }
        const is_camera_exist = await altum_request(
          'GET',
          `/cameras/${device.sr_num}`,
          null,
          device.client_id,
          device.client_secret,
        );

        if (is_camera_exist?.data?.camera) {
          return {
            _id: device._id,
            type: device.type,
            resident: device.resident,
            status,
            last_seen: null,
            camera_data: { ...is_camera_exist.data.camera },
          };
        }
      }
      if (type_normalized === 'zigbee') {
        const last_seen = zigbee_log_map[device.id] || null;
        const zigbee_online = last_seen ? last_seen >= one_hour_ago : false;
        return {
          ...device,
          id: device.id,
          ieee: device.ieee,
          sensor_type: device.sensor_type,
          room: device.room,
          status: zigbee_online ? 'online' : 'offline',
          last_seen,
        };
      }
      if (type_normalized === 'cpplus') {
        const camera_online =
          device.camera_last_seen &&
          new Date(device.camera_last_seen).getTime() >= Date.now() - 2 * 60 * 1000;
        return {
          ...device,
          stream_name: device.stream_name,
          local_ip: device.local_ip,
          room: device.room,
          hub_id: device.hub_id || null,
          status: camera_online ? 'online' : 'offline',
          last_seen: device.camera_last_seen || null,
        };
      }
      return {
        _id: device._id,
        type: device.type,
        resident: device.resident,
        status: 'unknown',
        last_seen: null,
      };
    }),
  );

  return final;
};
// Reorders one device "category" of a resident's devices — a type for
// Eltum/Emfit/CpPlus, or a type+sensor_type for Zigbee (e.g. just their
// motion sensors, separate from their contact sensors) — per the given
// device_ids order (index 0 = first). This only breaks ties *within* a
// category; which category comes first is governed by the resident's
// device_category_order template (see resident_service). device_ids must be
// exactly the set of device ids in that category, no more, no less, so a
// category's ordering can never leave a device out. Other categories'
// sort_order is untouched, so each one can be reordered independently.
const sort_devices_for_resident = async (resident_id, type, sensor_type, device_ids) => {
  // Zigbee sensor_type is matched alias-normalized (e.g. "contact" and
  // "door & window" mean the same sensor — see helper/device_category.js),
  // since production devices store either spelling.
  const candidates = await device_model
    .find({ resident: resident_id, type })
    .select('_id sensor_type')
    .lean();

  const existing_devices =
    type === 'Zigbee'
      ? candidates.filter(
          (d) => normalize_sensor_type(d.sensor_type) === normalize_sensor_type(sensor_type),
        )
      : candidates;

  const existing_ids = new Set(existing_devices.map((d) => d._id.toString()));
  const submitted_ids = new Set(device_ids.map((id) => id.toString()));

  if (
    existing_ids.size !== submitted_ids.size ||
    [...existing_ids].some((id) => !submitted_ids.has(id))
  ) {
    const category_label = type === 'Zigbee' ? `${type} (${sensor_type})` : type;
    return {
      success: false,
      message: `devices must include every ${category_label} device belonging to this resident, with no duplicates`,
    };
  }

  await device_model.bulkWrite(
    device_ids.map((id, index) => ({
      updateOne: {
        filter: { _id: id, resident: resident_id, type },
        update: { $set: { sort_order: index } },
      },
    })),
  );

  const devices = await device_model
    .find({ _id: { $in: device_ids } })
    .select('_id type sort_order sensor_type')
    .sort({ sort_order: 1, _id: 1 })
    .lean();

  return { success: true, message: 'Device order updated successfully', data: devices };
};

const get_device_by_sr_num = async (sr_num) => await get_device_details({ sr_num }).lean();
const get_device_by_camera_id = async (camera_id) => await get_device_details({ camera_id }).lean();
const get_device_by_zigbee_id = async (id) =>
  !id ? null : await get_device_details({ type: 'Zigbee', id }).lean();
const signin_altum_device = async (device_id, user_id) => {
  let device;

  try {
    device = await get_any_device_by_id(device_id);

    if (!device) {
      return {
        success: false,
        message: 'Device not found',
      };
    }

    if (device.status !== 'active') {
      return {
        success: false,
        message: 'Device is disabled by admin',
      };
    }

    if (device.type?.toLowerCase() !== 'eltum') {
      return {
        success: false,
        message: 'Invalid device type',
      };
    }

    // 🟡 STEP 1 → mark progress
    device.device_status = 'USER_SIGNIN_IN_PROGRESS';
    await device.save();

    // 🔐 STEP 2 → get token
    const { access_token, group_id } = await get_altum_token(
      device.client_id,
      device.client_secret,
      device.scope,
      true,
    );
    // 💾 save token in DB (IMPORTANT)
    device.altum_token = access_token;
    device.token_updated_at = new Date();

    // 🏠 STEP 3 → create room
    // const room = await altumRequest(
    //   'POST',
    //   '/rooms',
    //   { name: device.name || 'Room' },
    //   device.client_id,
    //   device.client_secret,
    // );

    // const roomId = room?.id || room?._id;
    // if (!roomId) throw new Error('Room creation failed');

    // // 📷 STEP 4 → create camera
    // const camera = await altumRequest(
    //   'POST',
    //   `/rooms/${roomId}/cameras`,
    //   { name: 'Camera' },
    //   device.client_id,
    //   device.client_secret,
    // );

    // const cameraId = camera?.id || camera?._id;
    // if (!cameraId) throw new Error('Camera creation failed');

    // // 💾 STEP 5 → save mapping
    // device.camera_id = cameraId;

    // // 🟢 STEP 6 → success
    // device.device_status = 'USER_SIGNIN_DONE';
    await device.save();

    return {
      success: true,
      message: 'Device setup started',
      data: {
        altum_token: access_token || null,
        group_id: group_id || null,
        expires_in: 3599,
        device_id: device._id,
      },
    };
  } catch (error) {
    console.error('Altum Signin Error:', error.message);

    if (device && device.device_status !== 'USER_SIGNIN_DONE') {
      device.device_status = 'ADMIN_MAPPED';
      await device.save();
    }

    return {
      success: false,
      message: 'Something went wrong with device setup',
    };
  }
};
const update_device_mapping = async (device_id, user_id, serial_number, firmware_version) => {
  try {
    const device = await get_any_device_by_id(device_id);
    // ❌ Device not found
    if (!device) {
      return {
        success: false,
        message: 'Device not found',
      };
    }

    // ❌ Not active
    if (device.status !== 'active') {
      return {
        success: false,
        message: 'Device is disabled by admin',
      };
    }

    // ❌ Wrong type
    if (device.type?.toLowerCase() !== 'eltum') {
      return {
        success: false,
        message: 'Invalid device type',
      };
    }
    const resident = await resident_model.findOne({ creator: user_id, _id: device.resident });
    // ❌ Ownership check (IMPORTANT)
    if (!resident) {
      return {
        success: false,
        message: 'Unauthorized device access',
      };
    }

    // 🟡 Update mapping fields
    if (serial_number) {
      device.sr_num = serial_number;
    }

    if (firmware_version) {
      device.firmware_version = firmware_version;
    }

    await device.save();
    const bluetooth_token = await altum_request(
      'GET',
      `/cameras/bluetoothToken?serial_number=${serial_number}`,
      null,
      device.client_id,
      device.client_secret,
    );
    return {
      success: true,
      message: 'Device mapping updated successfully',
      data: { bluetooth_token: bluetooth_token?.data?.bluetooth_token || null },
    };
  } catch (error) {
    console.error('Update Device Mapping Error:', error.message);

    return {
      success: false,
      message: 'Something went wrong with device setup',
    };
  }
};
const create_altum_setup = async (device_id, user_id) => {
  let device;

  try {
    device = await get_any_device_by_id(device_id);

    // ❌ Device not found
    if (!device) {
      return { success: false, message: 'Device not found' };
    }

    // ❌ Not active
    if (device.status !== 'active') {
      return { success: false, message: 'Device is disabled by admin' };
    }

    // ❌ Wrong type
    if (device.type?.toLowerCase() !== 'eltum') {
      return { success: false, message: 'Invalid device type' };
    }

    // ❌ Must be mapped to resident
    if (!device.resident) {
      return {
        success: false,
        message: 'Device not assigned to resident',
      };
    }

    // ❌ Ownership check (optimized)
    const is_owner = await resident_model.exists({
      _id: device.resident,
      creator: user_id,
    });

    if (!is_owner) {
      return {
        success: false,
        message: 'Unauthorized device access',
      };
    }

    // ❌ Must have token (from signin API)
    if (!device.altum_token) {
      return {
        success: false,
        message: 'Device not ready for setup',
      };
    }

    // ❌ Prevent duplicate setup
    if (device.camera_id) {
      return {
        success: false,
        message: 'Device already configured',
      };
    }
    const is_camera_exist = await altum_request(
      'GET',
      `/cameras/${device.sr_num}`,
      null,
      device.client_id,
      device.client_secret,
    );
    let mqtt_passcode;
    if (!is_camera_exist?.data?.camera) {
      // 🏠 STEP 1 → create room
      const room = await altum_request(
        'POST',
        '/rooms',
        { friendly_name: device.sr_num + '_Room' },
        device.client_id,
        device.client_secret,
      );
      const room_id = room?.data?.room?.id || null;
      if (!room_id) throw new Error('Room creation failed');

      // 📷 STEP 2 → create camera
      const camera = await altum_request(
        'POST',
        `/cameras`,
        {
          friendly_name: `${device?.sr_num?.slice(-4)}_Camera`,
          room_id: room_id, // or use roomId variable
          serial_number: device.sr_num,
          version: device.firmware_version,
          is_initial_config: true,
        },
        device.client_id,
        device.client_secret,
      );
      const camera_id = camera?.data?.camera?.id || null;
      if (!camera_id) throw new Error('Camera creation failed');

      // 💾 Save mapping
      device.room_id = room_id;
      device.camera_id = camera_id;
      mqtt_passcode = camera?.data?.camera?.mqtt_passcode;
      device.device_status = 'USER_SIGNIN_DONE';
      await device.save();
    } else {
      mqtt_passcode = is_camera_exist?.data?.camera?.mqtt_passcode;
      if (!device.camera_id) {
        device.camera_id = is_camera_exist?.data?.camera?.id;
        await device.save();
      }
    }
    return {
      success: true,
      message: 'Device setup completed',
      data: {
        device_id: device._id,
        mqtt_passcode: mqtt_passcode,
      },
    };
  } catch (error) {
    console.error('Altum Setup Error:', error.message);

    return {
      success: false,
      message: 'Something went wrong with device setup',
    };
  }
};

// 🔹 shared validation
const validate_device_access = async (device_id, user_id) => {
  const device = await get_any_device_by_id(device_id);

  if (!device) {
    return { success: false, message: 'Device not found' };
  }

  if (device.status !== 'active') {
    return { success: false, message: 'Device is disabled by admin' };
  }

  if (device.type?.toLowerCase() !== 'eltum') {
    return { success: false, message: 'Invalid device type' };
  }
  const resident = await resident_model.findOne({
    creator: user_id,
    _id: device.resident,
  });

  if (!resident) {
    return { success: false, message: 'Unauthorized device access' };
  }

  if (!device.camera_id) {
    return { success: false, message: 'Device not fully configured' };
  }

  return { success: true, device };
};

// ======================================================
// 1️⃣ get_preview_image
// ======================================================

const get_preview_image = async (device_id, user_id, preview_token) => {
  const check = await validate_device_access(device_id, user_id);
  if (!check.success) return check;

  const { device } = check;

  if (!preview_token) {
    return {
      success: false,
      message: 'Preview token is required',
    };
  }

  try {
    const data = await altum_request(
      'GET',
      `/cameras/${device.camera_id}/view`,
      { preview_token },
      device.client_id,
      device.client_secret,
    );

    return {
      success: true,
      message: 'Preview fetched',
      data,
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to fetch preview',
    };
  }
};

// ======================================================
// 2️⃣ calibrate_camera
// ======================================================

const calibrate_camera = async (device_id, user_id) => {
  const check = await validate_device_access(device_id, user_id);
  if (!check.success) return check;

  const { device } = check;

  try {
    await altum_request(
      'GET',
      `/cameras/${device.camera_id}/calibrate`,
      null,
      device.client_id,
      device.client_secret,
    );

    return {
      success: true,
      message: 'Calibration completed',
    };
  } catch (error) {
    return {
      success: false,
      message: 'Calibration failed',
    };
  }
};

// ======================================================
// 3️⃣ save_background
// ======================================================

const save_background = async (device_id, user_id) => {
  const check = await validate_device_access(device_id, user_id);
  if (!check.success) return check;

  const { device } = check;

  try {
    await altum_request(
      'GET',
      `/cameras/${device.camera_id}/floormask/switch`,
      null,
      device.client_id,
      device.client_secret,
    );

    return {
      success: true,
      message: 'Background saved successfully',
    };
  } catch (error) {
    return {
      success: false,
      message: 'Background save failed',
    };
  }
};
// services/device.service.js

// ─────────────────────────────────────────
// Camera Status (cameraById)
// ─────────────────────────────────────────
const get_camera_status = async (device_id, user_id) => {
  const check = await validate_device_access(device_id, user_id);
  if (!check.success) return check;

  const { device } = check;

  try {
    const data = await altum_request(
      'GET',
      `/cameras/${device.camera_id}`,
      null,
      device.client_id,
      device.client_secret,
    );

    return {
      success: true,
      data: data?.data?.camera || data,
    };
  } catch (error) {
    return { success: false, message: 'Failed to fetch camera status' };
  }
};

// ─────────────────────────────────────────
// Background URL (NOT image bytes)
// ─────────────────────────────────────────
const get_background_url = async (device_id, user_id) => {
  const check = await validate_device_access(device_id, user_id);
  if (!check.success) return check;

  const { device } = check;

  try {
    const data = await altum_request(
      'GET',
      `/cameras/${device.camera_id}/background`,
      null,
      device.client_id,
      device.client_secret,
    );

    return {
      success: true,
      data: { background_url: data?.data?.background_url },
    };
  } catch (error) {
    return { success: false, message: 'Failed to fetch background URL' };
  }
};

// ─────────────────────────────────────────
// Stream Token
// ─────────────────────────────────────────
const get_stream_token = async (device_id, user_id) => {
  const check = await validate_device_access(device_id, user_id);
  if (!check.success) return check;

  const { device } = check;

  try {
    const data = await altum_request(
      'GET',
      `/cameras/${device.camera_id}/streamtoken`,
      null,
      device.client_id,
      device.client_secret,
    );

    return {
      success: true,
      data: { stream_token: data?.data?.stream_token },
    };
  } catch (error) {
    return { success: false, message: 'Failed to fetch stream token' };
  }
};

// ─────────────────────────────────────────
// MQTT Credentials
// ─────────────────────────────────────────
const get_mqtt_credentials = async (device_id, user_id) => {
  const check = await validate_device_access(device_id, user_id);
  if (!check.success) return check;

  const { device } = check;

  try {
    const data = await altum_request(
      'GET',
      `/mqttAccount`,
      null,
      device.client_id,
      device.client_secret,
    );

    return {
      success: true,
      data,
    };
  } catch (error) {
    return { success: false, message: 'Failed to fetch MQTT credentials' };
  }
};

// ─────────────────────────────────────────
// Group Info (/info)
// ─────────────────────────────────────────
const get_group_info = async (device_id, user_id) => {
  const check = await validate_device_access(device_id, user_id);
  if (!check.success) return check;

  const { device } = check;

  try {
    const data = await altum_request('GET', `/info`, null, device.client_id, device.client_secret);

    return {
      success: true,
      data: { group_id: data?.data?.group_id },
    };
  } catch (error) {
    return { success: false, message: 'Failed to fetch group info' };
  }
};
// ======================================================
// PERSON GROUPS
// ======================================================

const get_person_groups = async (device_id, user_id) => {
  const check = await validate_device_access(device_id, user_id);
  if (!check.success) return check;

  const { device } = check;

  try {
    const response = await altum_request(
      'GET',
      '/people/groups',
      null,
      device.client_id,
      device.client_secret,
    );

    return {
      success: true,
      data: { groups: response?.data?.person_groups?.array || [] },
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to fetch groups',
    };
  }
};

const create_person_group = async (device_id, payload, user_id) => {
  const check = await validate_device_access(device_id, user_id);
  if (!check.success) return check;

  const { device } = check;

  try {
    const response = await altum_request(
      'POST',
      '/people/groups',
      payload,
      device.client_id,
      device.client_secret,
    );

    return {
      success: true,
      data: response?.data,
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to create group',
    };
  }
};

const update_person_group = async (device_id, group_id, payload, user_id) => {
  const check = await validate_device_access(device_id, user_id);
  if (!check.success) return check;

  const { device } = check;

  try {
    await altum_request(
      'PATCH',
      `/people/groups/${group_id}`,
      payload,
      device.client_id,
      device.client_secret,
    );

    return {
      success: true,
      message: 'Group updated successfully',
      data: { group_id, ...payload },
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to update group',
    };
  }
};

const delete_person_group = async (device_id, group_id, user_id) => {
  const check = await validate_device_access(device_id, user_id);
  if (!check.success) return check;

  const { device } = check;

  try {
    await altum_request(
      'DELETE',
      `/people/groups/${group_id}`,
      null,
      device.client_id,
      device.client_secret,
    );

    return {
      success: true,
      message: 'Group deleted successfully',
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to delete group',
    };
  }
};
// ======================================================
// PEOPLE
// ======================================================

const get_people = async (device_id, user_id) => {
  const check = await validate_device_access(device_id, user_id);
  if (!check.success) return check;

  const { device } = check;

  try {
    const response = await altum_request(
      'GET',
      '/people',
      null,
      device.client_id,
      device.client_secret,
    );

    return {
      success: true,
      data: { people: response?.data?.people?.array || [] },
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to fetch people',
    };
  }
};

const create_person = async (device_id, payload, user_id) => {
  const check = await validate_device_access(device_id, user_id);
  if (!check.success) return check;

  const { device } = check;
  const form = new FormData();
  form.append('image', 'image_buffer', {
    filename: 'face.jpg',
    contentType: 'image/jpeg',
  });
  try {
    const response = await altum_request(
      'POST',
      '/people',
      payload,
      device.client_id,
      device.client_secret,
    );

    return {
      success: true,
      data: response?.data,
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to create person',
    };
  }
};

const update_person = async (device_id, person_id, payload, user_id) => {
  const check = await validate_device_access(device_id, user_id);
  if (!check.success) return check;

  const { device } = check;

  try {
    await altum_request(
      'PATCH',
      `/people/${person_id}`,
      payload,
      device.client_id,
      device.client_secret,
    );

    return {
      success: true,
      message: 'Person updated successfully',
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to update person',
    };
  }
};

const delete_person = async (device_id, person_id, user_id) => {
  const check = await validate_device_access(device_id, user_id);
  if (!check.success) return check;

  const { device } = check;

  try {
    await altum_request(
      'DELETE',
      `/people/${person_id}`,
      null,
      device.client_id,
      device.client_secret,
    );

    return {
      success: true,
      message: 'Person deleted successfully',
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to delete person',
    };
  }
};
const assign_person_group = async (device_id, person_id, group_id, user_id) => {
  const check = await validate_device_access(device_id, user_id);
  if (!check.success) return check;

  const { device } = check;

  try {
    await altum_request(
      'PATCH',
      `/people/${person_id}`,
      { person_group_id: group_id },
      device.client_id,
      device.client_secret,
    );

    return {
      success: true,
      message: 'Person assigned to group successfully',
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to assign person group',
    };
  }
};
const upload_person_face = async (device_id, person_id, image_buffer, user_id) => {
  const check = await validate_device_access(device_id, user_id);
  if (!check.success) return check;

  const { device } = check;

  const form = new FormData();

  form.append('image', image_buffer.buffer, {
    filename: image_buffer.originalname || 'face.jpg',
    contentType: image_buffer.mimetype || 'image/jpeg',
  });

  try {
    const response = await altum_request(
      'POST',
      `/people/${person_id}/faces`,
      form,
      device.client_id,
      device.client_secret,
    );

    return {
      success: true,
      data: response?.data,
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to upload person face',
    };
  }
};
const get_alerts = async (device_id, query, user) => {
  const check = await validate_device_access(device_id, user);

  if (!check.success) {
    return check;
  }

  const { device } = check;

  const params = [];

  // Defaults matching Flutter
  const page_length = query.page_length || 50;

  params.push(`page_length=${page_length}`);
  params.push('direction=DESC');

  // Alert status filters (same priority order as Flutter)
  if (query.show_unresolved === 'true') {
    params.push('show_unresolved=true');
  } else if (query.show_resolved === 'true') {
    params.push('show_resolved=true');
  } else if (query.show_true_alerts === 'true') {
    params.push('show_true_alerts=true');
  } else if (query.show_false_alerts === 'true') {
    params.push('show_false_alerts=true');
  } else {
    params.push('show_unresolved=true');
    params.push('show_resolved=true');
  }

  // Event types
  let event_types = query.event_types || query['event_types[]'];

  if (!event_types) {
    // Same default as Flutter AltumEventType.all
    event_types = [1, 2, 3, 4, 5, 10, 11];
  }

  if (!Array.isArray(event_types)) {
    event_types = [event_types];
  }

  event_types.forEach((type) => {
    params.push(`event_types[]=${encodeURIComponent(type)}`);
  });

  const url = `/alerts?${params.join('&')}`;

  const response = await altum_request('GET', url, null, device.client_id, device.client_secret);

  return {
    success: true,
    data: response.data,
  };
};

const get_alert_by_id = async (device_id, alert_id, user) => {
  const check = await validate_device_access(device_id, user);
  if (!check.success) return check;

  const { device } = check;

  const response = await altum_request(
    'GET',
    `/alerts/${alert_id}`,
    null,
    device.client_id,
    device.client_secret,
  );

  return { success: true, data: response.data };
};

const resolve_alert = async (device_id, alert_id, body, user) => {
  const check = await validate_device_access(device_id, user);
  if (!check.success) return check;

  const { device } = check;

  const response = await altum_request(
    'PATCH',
    `/alerts/${alert_id}`,
    body,
    device.client_id,
    device.client_secret,
  );
  return { success: true, message: response?.message, data: { is_resolved: response?.success } };
};

const resolve_all_alerts = async (device_id, user) => {
  const check = await validate_device_access(device_id, user);
  if (!check.success) return check;

  const { device } = check;

  const response = await altum_request(
    'PATCH',
    `/alerts/all`,
    null,
    device.client_id,
    device.client_secret,
  );

  return { success: true, message: response?.message, data: { is_resolved: response?.success } };
};
const get_alert_settings = async (device_id, camera_id, user) => {
  const check = await validate_device_access(device_id, user);
  if (!check.success) return check;

  const { device } = check;

  const response = await altum_request(
    'GET',
    `/cameras/${camera_id}`,
    null,
    device.client_id,
    device.client_secret,
  );
  const camera = response?.data?.camera;

  if (!camera) {
    return {
      success: false,
      message: 'Camera data missing',
    };
  }

  return {
    success: true,
    data: { ...camera },
  };
};

const update_alert_settings = async (device_id, camera_id, settings, user) => {
  const check = await validate_device_access(device_id, user);

  if (!check.success) {
    return check;
  }

  const { device } = check;

  const response = await altum_request(
    'PATCH',
    `/cameras/${camera_id}`,
    settings,
    device.client_id,
    device.client_secret,
  );
  return {
    success: true,
    message: response?.message || 'Alert settings updated',
  };
};
const get_alert_analytics = async (device_id, query, user) => {
  const check = await validate_device_access(device_id, user);

  if (!check.success) return check;

  const { device } = check;

  if (!query.date) {
    return {
      success: false,
      message: 'date is required (YYYY-MM-DD)',
    };
  }

  // -----------------------------
  // EVENT MAPPING
  // -----------------------------
  const help_event_type = eltum_event_types.HandWave; // 5
  const fall_event_type = eltum_event_types.Fall; // 1

  // -----------------------------
  // SAFE UTC DATE RANGE
  // -----------------------------
  const [year, month, day] = query.date.split('-').map(Number);

  const start_date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  const end_date = new Date(Date.UTC(year, month - 1, day + 1, 0, 0, 0));

  const start_ts = Math.floor(start_date.getTime() / 1000);
  const end_ts = Math.floor(end_date.getTime() / 1000);

  // -----------------------------
  // FETCH ALERTS
  // -----------------------------
  const params = [
    'page_length=1000',
    'direction=DESC',
    'show_unresolved=true',
    'show_resolved=true',
    `event_types[]=${help_event_type}`,
    `event_types[]=${fall_event_type}`,
  ];

  const url = `/alerts?${params.join('&')}`;

  const response = await altum_request('GET', url, null, device.client_id, device.client_secret);

  const alerts = response?.data?.alerts?.array || [];

  // -----------------------------
  // FILTER BY SELECTED DATE
  // -----------------------------
  const filtered_alerts = alerts.filter((a) => a.unix_time >= start_ts && a.unix_time < end_ts);

  // -----------------------------
  // GROUPING
  // -----------------------------
  const grouped = {};

  let help_count = 0;
  let fall_count = 0;

  for (const alert of filtered_alerts) {
    const date = new Date(alert.unix_time * 1000);

    // ✅ IST-safe hour conversion
    const hour = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).getHours();

    if (!grouped[hour]) {
      grouped[hour] = {
        timestamp: hour,
        help: 0,
        fall: 0,
      };
    }

    if (alert.event_type === help_event_type) {
      grouped[hour].help += 1;
      help_count++;
    }

    if (alert.event_type === fall_event_type) {
      grouped[hour].fall += 1;
      fall_count++;
    }
  }

  // -----------------------------
  // ALWAYS RETURN 24 HOURS
  // -----------------------------
  const data = [];

  for (let h = 0; h < 24; h++) {
    data.push(
      grouped[h] || {
        timestamp: h,
        help: 0,
        fall: 0,
      },
    );
  }

  // -----------------------------
  // SCALE CALCULATION
  // -----------------------------
  const max_value = Math.max(...data.flatMap((d) => [d.help, d.fall]), 0);

  const max_scale = max_value === 0 ? 10 : Math.ceil(max_value * 1.2);

  // -----------------------------
  // RESPONSE
  // -----------------------------
  return {
    success: true,
    data: {
      date: query.date,
      help_count,
      fall_count,
      graph: {
        min_scale: 0,
        max_scale,
        data,
      },
    },
  };
};

export {
  create_device,
  get_device_by_id,
  update_device_status,
  update_device,
  get_all_devices_cursor,
  get_all_device_listng,
  sort_devices_for_resident,
  get_device_by_sr_num,
  get_device_by_camera_id,
  get_device_by_zigbee_id,
  check_device,
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
  update_person,
  delete_person,
  assign_person_group,
  upload_person_face,
  get_alerts,
  get_alert_by_id,
  resolve_alert,
  resolve_all_alerts,
  get_alert_settings,
  update_alert_settings,
  get_cpplus_stream_url,
  is_emfit_exist,
  get_alert_analytics,
  get_device_details,
  get_devices,
  get_any_device_by_id,
  delete_device,
};
