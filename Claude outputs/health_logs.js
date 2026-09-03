import emfit_logs from '../models/emfit_logs.js';
import zigbee_log from '../models/zigbee_log.js';
import socket_service from '../utils/socket.js';
import device_model from '../models/device.js';
import user from '../models/users.js';
import resident from '../models/resident.js';
import { async_handler } from '../middleware/errorMiddleware.js';
import { alert_levels, vital_thresholds, testing_flag } from '../config/month_name.js';
import unknown_route_log from '../models/unknown_routelog.js';
import { get_alert_level, add_socket_debug } from '../helper/index.js';
import { get_devices } from './device_service.js';
import cron from 'node-cron';
import alert_state from '../models/alert_state.js';
import alert_log from '../models/alert_log.js';
import contact_alert_settings from '../models/contact_alert_settings.js';
import room_state_model from '../models/room_state.js';
import no_motion_settings from '../models/no_motion_settings.js';
import { dispatch_notification, is_alert_muted } from './notification_service.js';
import { DeviceCategory } from '../constants/notification_events.js';
import hub_service from './hub_service.js';

// Best-effort door-vs-window classification for a Zigbee contact sensor.
// The schema has no dedicated door/window field (device.room / device.id
// carry whatever free-text label the sensor was set up with, e.g.
// "main_gate", "kitchen_window" -- see docs/zigbee.swagger.json examples),
// so this matches on the word "window" and otherwise assumes a door
// (covers "main_gate" and any other entryway label). Good enough to pick
// the right push copy; not used for anything safety-critical.
const classify_contact_device = (device) => {
  const label = `${device?.room || ''} ${device?.id || device?.zigbee_id || ''}`.toLowerCase();
  return label.includes('window') ? 'window' : 'door';
};

// Splits a single-vital alert level into which vital (heart_rate /
// respiration_rate) drove it and which direction it breached in, so push
// copy can say "elevated" vs "low" instead of a generic "abnormal vitals".
const get_vital_direction = (value, config) => {
  if (value == null || !config) return null;
  if (value > config.normal.max) return 'high';
  if (value < config.normal.min) return 'low';
  return null;
};
// const create_emfit_log = async (device_id, data) => {
//   return await emfit_logs.create({ ...data, device_id });
// };
const map_sleep_stage = (status) => {
  switch (status) {
    case 'in_bed':
      return 'sleeping';

    case 'out_of_bed':
      return 'awake';

    default:
      return 'unknown';
  }
};

// =========================================
// OLD PI BRIDGE DATA RECOVERY
// =========================================

const glk_status_map = {
  0: 'initializing',
  1: 'in_bed',
  2: 'apnea_suspected',
  3: 'snoring',
  4: 'out_of_bed',
  5: 'life_abnormality',
  6: 'light_sleep',
};

const glk_in_bed_statuses = new Set([1, 2, 3, 5, 6]);

/**
 * Parse a raw GLK BLE frame (hex string) to extract vitals.
 * Frame: [0x82][length][ack][seq][cmd][payload...][checksum]
 * Payload (when starts with 0x6A marker, >=11 bytes):
 *   [0]=0x6A  [1]=0x8A/0x8C  [2]=timer  [3]=reserved
 *   [4]=HR    [5]=RR          [6]=status [7]=battery
 *   [8]=rsvd  [9]=signal      [10]=movement
 */
const parse_glk_raw_frame = (raw_hex) => {
  try {
    if (!raw_hex || typeof raw_hex !== 'string') return null;
    const buf = Buffer.from(raw_hex, 'hex');
    if (buf.length < 7 || buf[0] !== 0x82) return null;

    const payload = buf.slice(5, buf.length - 1);

    if (payload.length >= 11 && payload[0] === 0x6a) {
      const status_code = payload[6];
      const status_label = glk_status_map[status_code] || 'unknown';
      return {
        heart_rate: payload[4],
        respiration_rate: payload[5],
        status_code,
        status: status_label,
        in_bed: glk_in_bed_statuses.has(status_code),
        battery_level: payload[7],
        body_movement: payload[10],
        signal_strength: payload[9],
        snoring: status_code === 3,
        apnea_suspected: status_code === 2,
      };
    }

    return null; // valid frame but payload too short for vitals
  } catch (e) {
    return null;
  }
};

/**
 * Detect and correct data from the broken GLK bridge.
 *
 * Broken bridge signature: HR is always 106 (0x6A) and RR is always 138
 * (0x8A) — protocol marker bytes p[0] and p[1] were misread as vitals.
 *
 * Actual vitals are hidden in misaligned fields:
 *   - data.battery_level = actual heart rate (byte p[4])
 *   - data.sn hex [0:2] = actual respiration rate (p[5])
 *   - data.sn hex [2:4] = actual status code (p[6])
 *   - data.sn hex [4:6] = actual battery level (p[7])
 *   - data.sn hex [10:12] = actual body movement (p[10])
 *
 * Once the Pi bridge is updated, HR will no longer be 106 and this
 * function becomes a no-op.
 */
const fix_broken_bridge_data = (data) => {
  // Broken bridge reads marker bytes as vitals: p[0]=0x6A(106) as HR,
  // p[1] as RR — p[1] is a protocol sub-byte that varies (0x8A=138,
  // 0x8C=140, etc.).  Normal human RR never exceeds ~30, so RR >= 130
  // reliably flags a marker byte without matching real readings.
  if (data.heart_rate !== 106 || data.respiration_rate == null || data.respiration_rate < 130)
    return data;

  // Recover actual vitals from misaligned fields.
  // NOTE: 0 is a valid value (means out of bed / no pulse detected),
  // so we use isNaN checks instead of || null which would discard 0.
  const hr_parsed = parseInt(data.battery_level);
  const actual_hr = isNaN(hr_parsed) ? null : hr_parsed;

  let actual_rr = null;
  let actual_status = null;
  let actual_battery = null;
  let actual_movement = null;

  // data.sn is hex-encoded bytes p[5:11]:
  //   [0:2] = RR (p[5]), [2:4] = status (p[6]),
  //   [4:6] = battery (p[7]), [10:12] = movement (p[10])
  if (data.sn && typeof data.sn === 'string') {
    try {
      const rr_val = parseInt(data.sn.substring(0, 2), 16);
      actual_rr = isNaN(rr_val) ? null : rr_val;
      actual_status = parseInt(data.sn.substring(2, 4), 16);
      actual_battery = parseInt(data.sn.substring(4, 6), 16);
      if (data.sn.length >= 12) {
        actual_movement = parseInt(data.sn.substring(10, 12), 16);
      }
    } catch (e) {
      // sn not valid hex — leave vitals null
    }
  }

  const status_label =
    actual_status != null ? glk_status_map[actual_status] || 'unknown' : 'in_bed';

  return {
    ...data,
    heart_rate: actual_hr,
    respiration_rate: actual_rr,
    status: status_label,
    in_bed: actual_status != null ? glk_in_bed_statuses.has(actual_status) : true,
    out_of_bed: actual_status === 4,
    battery_level: actual_battery,
    body_movement: actual_movement,
    snoring: actual_status === 3,
    apnea_suspected: actual_status === 2,
  };
};

/**
 * Build a consistent emfit-compatible record.  Every return path in
 * map_sleep_new_device_to_old_format funnels through here so the stored
 * object always has the same 20-field shape with consistent types.
 */
const build_emfit_record = ({
  serialnumber,
  date_occurred = null,
  in_bed = false,
  heart_rate = null,
  respiration_rate = null,
  body_movement = 0,
  snoring = false,
  apnea_suspected = false,
  status = 'unknown',
  // ── GLK v24 fields ──
  battery_level = null,
  signal_quality = null,
  life_abnormality = null,
  out_of_bed = null,
  glk_sleep_stage = null,
  data_type = null,
}) => ({
  // ── existing 20 Emfit-compatible fields (unchanged) ──
  serialnumber,
  date_occurred,
  in_bed,
  restless: body_movement > 100,
  fast_movement: null,
  sitting_in_bed: null,
  intention_to_leave_bed: !in_bed,
  heart_rate: heart_rate ?? null,
  respiration_rate: respiration_rate ?? null,
  activity: body_movement || 0,
  ii_heart_beat: null,
  snoring: snoring ?? false,
  breathing_disturbance: apnea_suspected ?? false,
  tossnturn: body_movement > 100,
  turning_reminder: null,
  movement_in_room: null,
  may_have_fallen_from_bed: null,
  too_long_sitting: null,
  sleep_stage: in_bed ? 'sleeping' : map_sleep_stage(status),
  too_long_staying_in_bed: null,
  // ── GLK v24 fields (new, alongside existing) ──
  apnea_suspected: apnea_suspected ?? null,
  life_abnormality: life_abnormality ?? null,
  battery_level: battery_level ?? null,
  signal_quality: signal_quality ?? null,
  body_movement: body_movement ?? null,
  glk_status: status ?? null,
  out_of_bed: out_of_bed ?? null,
  glk_sleep_stage: glk_sleep_stage ?? null,
  data_type: data_type ?? null,
});

const map_sleep_new_device_to_old_format = (payload) => {
  const raw_data = payload?.data || {};

  // GLK bridge sends serial_number (underscore) at top level = the 12-digit
  // device serial used during BLE pairing, which matches sr_num in the devices
  // collection.  Prefer the top-level serial for dashboard lookups.
  const serial = payload?.serial_number || raw_data.sn || payload?.serialnumber;

  // ── v24: device_status (connected/disconnected) — not health data, skip ──
  if (raw_data.type === 'device_status') {
    console.log(
      `[GLK_ORGANIC_DATA] serial=${serial} source=DEVICE_STATUS event=${raw_data.event} fw=${raw_data.firmware} ip=${raw_data.ip_address} ts=${payload?.timestamp}`,
    );
    return null;
  }

  // ── v24: emergency — life_abnormality detected ──
  if (raw_data.type === 'emergency') {
    console.log(
      `[GLK_ORGANIC_DATA] serial=${serial} source=EMERGENCY life_abnormality=${raw_data.life_abnormality} status=${raw_data.status} ts=${payload?.timestamp}`,
    );
    return build_emfit_record({
      serialnumber: serial,
      date_occurred: payload?.timestamp,
      in_bed: raw_data.in_bed ?? true,
      heart_rate: raw_data.heart_rate,
      respiration_rate: raw_data.respiration_rate,
      status: raw_data.status || 'life_abnormality',
      life_abnormality: true,
      out_of_bed: raw_data.out_of_bed ?? false,
      data_type: 'emergency',
    });
  }

  // ── v24: sleep_stage with pre-parsed fields (bridge already decoded 0x4E) ──
  if (raw_data.type === 'sleep_stage' && (raw_data.sleep_stage != null || raw_data.sleep_stage_code != null)) {
    console.log(
      `[GLK_ORGANIC_DATA] serial=${serial} source=SLEEP_STAGE_PARSED stage=${raw_data.sleep_stage} HR=${raw_data.heart_rate} RR=${raw_data.respiration_rate} in_bed=${raw_data.in_bed} battery=${raw_data.battery_level} ts=${payload?.timestamp}`,
    );
    return build_emfit_record({
      serialnumber: serial,
      date_occurred: payload?.timestamp,
      in_bed: raw_data.in_bed ?? false,
      heart_rate: raw_data.heart_rate,
      respiration_rate: raw_data.respiration_rate,
      body_movement: raw_data.body_movement || 0,
      snoring: raw_data.snoring ?? false,
      apnea_suspected: raw_data.apnea_suspected ?? false,
      status: raw_data.status || 'in_bed',
      battery_level: raw_data.battery_level,
      signal_quality: raw_data.signal_quality,
      life_abnormality: raw_data.life_abnormality ?? false,
      out_of_bed: raw_data.out_of_bed ?? false,
      glk_sleep_stage: raw_data.sleep_stage,
      data_type: 'sleep_stage',
    });
  }

  // ── CMD_SLEEP_STAGE: raw hex frame from old bridge (legacy fallback) ──
  // Old bridge forwards these unparsed: { type: "sleep_stage", raw_hex: "82..." }
  if (raw_data.type === 'sleep_stage' && raw_data.raw_hex) {
    const parsed = parse_glk_raw_frame(raw_data.raw_hex);

    if (parsed) {
      console.log(
        `[GLK_ORGANIC_DATA] serial=${serial} source=CMD_SLEEP_STAGE HR=${parsed.heart_rate} RR=${parsed.respiration_rate} status=${parsed.status} in_bed=${parsed.in_bed} movement=${parsed.body_movement} snoring=${parsed.snoring} apnea=${parsed.apnea_suspected} battery=${parsed.battery_level} ts=${payload?.timestamp}`,
      );
      return build_emfit_record({
        serialnumber: serial,
        date_occurred: payload?.timestamp,
        in_bed: parsed.in_bed,
        heart_rate: parsed.heart_rate,
        respiration_rate: parsed.respiration_rate,
        body_movement: parsed.body_movement || 0,
        snoring: parsed.snoring,
        apnea_suspected: parsed.apnea_suspected,
        status: parsed.status,
        battery_level: parsed.battery_level,
        data_type: 'sleep_stage',
      });
    }

    console.log(
      `[GLK_ORGANIC_DATA] serial=${serial} source=CMD_SLEEP_STAGE_UNPARSED raw_hex_len=${raw_data.raw_hex?.length} ts=${payload?.timestamp}`,
    );
    // Could not extract vitals from frame — store with correct serial, null vitals
    return build_emfit_record({
      serialnumber: serial,
      date_occurred: payload?.timestamp,
      data_type: 'sleep_stage',
    });
  }

  // ── CMD_REALTIME or new device: auto-correct broken bridge data ──
  const data = fix_broken_bridge_data(raw_data);
  const was_bridge_corrected =
    raw_data.heart_rate === 106 &&
    raw_data.respiration_rate != null &&
    raw_data.respiration_rate >= 130;

  // Determine in_bed from corrected bridge data or vitals-based inference.
  const hr = data.heart_rate;
  const status = (data.status || '').toLowerCase();
  const bridge_in_bed = data.in_bed ?? false;
  const vitals_in_bed =
    hr != null && hr > 0 && status !== 'out_of_bed' && status !== 'initializing';
  const in_bed = bridge_in_bed || vitals_in_bed;

  console.log(
    `[GLK_ORGANIC_DATA] serial=${serial} source=CMD_REALTIME${was_bridge_corrected ? '_CORRECTED' : ''} HR=${data.heart_rate} RR=${data.respiration_rate} status=${data.status} in_bed=${in_bed} movement=${data.body_movement} snoring=${data.snoring} apnea=${data.apnea_suspected} battery=${data.battery_level} signal=${data.signal_quality} ts=${data.timestamp || payload?.timestamp}`,
  );

  return build_emfit_record({
    serialnumber: serial,
    date_occurred: data.timestamp || payload?.timestamp,
    in_bed,
    heart_rate: data.heart_rate,
    respiration_rate: data.respiration_rate,
    body_movement: data.body_movement || 0,
    snoring: data.snoring,
    apnea_suspected: data.apnea_suspected,
    status: data.status,
    battery_level: data.battery_level,
    signal_quality: data.signal_quality,
    life_abnormality: data.life_abnormality ?? false,
    out_of_bed: data.out_of_bed ?? false,
    data_type: 'realtime',
  });
};
const create_emfit_log = async (req) => {
  let body = req.body;

  // Device payload — OLD (nested) vs NEW (flat) format detection.
  //
  // OLD format shapes (all carry serial_number with underscore + nested data):
  //   1. sleep_update:  { type: 'sleep_update', data: { sn, ... } }
  //   2. GLK bridge realtime: { serial_number, data: { heart_rate, in_bed, ... }, timestamp }
  //   3. GLK bridge sleep_stage: { serial_number, data: { type: 'sleep_stage', raw_hex: '...' } }
  //   4. Any other bridge sub-shape with serial_number + data object
  //
  // NEW format is flat: { serialnumber (no underscore), in_bed, heart_rate, ... }
  // and passes through without transformation.
  //
  // The broad catch here — serial_number (underscore) + nested data object —
  // mirrors get_reading_body() in dashboard_service.js so both the ingestion
  // and the read path agree on what counts as "old format."
  if (
    (body?.type === 'sleep_update' && body?.data?.sn) ||
    (body?.serial_number && body?.data && typeof body.data === 'object')
  ) {
    body = map_sleep_new_device_to_old_format(body);

    // v24 device_status events return null — not health data, skip storage
    if (!body) return null;
  }

  // One log per device per 30-second window
  const time_bucket = Math.floor(Date.now() / 30000);

  try {
    const log = await emfit_logs.create({ ...body, time_bucket });

    // Write to unknown_route_log for dashboard compatibility.
    // Best-effort: a failure here must not lose the emfit_logs record.
    try {
      await unknown_route_log.create({
        method: req.method,
        path: req.originalUrl,
        body: body,
        params: req.params,
        query: req.query,
        headers: req.headers,
      });
    } catch (route_err) {
      console.error('[create_emfit_log] unknown_route_log write failed:', route_err.message);
    }

    return log;
  } catch (e) {
    if (e.code === 11000) {
      // Already stored a log in this 30-second window — skip
      return null;
    }

    // Non-dedup error on emfit_logs — still write to unknown_route_log so the
    // dashboard (which reads from this collection) does not lose data.
    try {
      await unknown_route_log.create({
        method: req.method,
        path: req.originalUrl,
        body: body,
        params: req.params,
        query: req.query,
        headers: req.headers,
      });
    } catch (route_err) {
      console.error('[create_emfit_log] unknown_route_log fallback write failed:', route_err.message);
    }

    throw e;
  }
};

// const create_zigbee_log = async ({ device_name, type, action, occupancy, contact, data }) => {
//   return await zigbee_log.create({
//     device_name,
//     type,
//     action,
//     occupancy,
//     contact,
//     data,
//   });
// };
const create_zigbee_log = async ({ device_name, type, action, occupancy, contact, data }) => {
  const time_bucket = Math.floor(Date.now() / 1000);
  try {
    return await zigbee_log.create({
      device_name,
      type,
      action,
      occupancy,
      contact,
      data,
      time_bucket,
    });
  } catch (e) {
    if (e.code === 11000) {
      return null;
    }
    throw e;
  }
};
const get_switch_data = async (device_name) => {
  const latest = await zigbee_log
    .findOne({
      device_name,
      type: 'switch',
      'data.action': { $exists: true },
    })
    .sort({ createdAt: -1 });

  if (!latest) {
    return {
      last_action: null,
      last_seen: null,
    };
  }
  const is_active = is_device_active(latest.createdAt);
  return {
    last_action: latest.data?.action || null,
    last_seen: latest.createdAt,
    is_active,
  };
};
// Counts switch click events for a device within the current calendar month.
// Pass `action` (e.g. 'single', 'long') to count only that action type;
// omit it to count all switch actions for the device this month.
const get_switch_click_count_this_month = async (device_name, action = null) => {
  const month_start = new Date();
  month_start.setDate(1);
  month_start.setHours(0, 0, 0, 0);

  const query = {
    device_name,
    type: 'switch',
    createdAt: { $gte: month_start },
  };

  if (action) query.action = action;

  return await zigbee_log.countDocuments(query);
};

const get_contact_data = async (device_name) => {
  const latest = await zigbee_log
    .findOne({
      device_name,
      type: 'contact',
      contact: { $exists: true },
    })
    .sort({ createdAt: -1 });

  if (!latest) {
    return {
      contact: null,
      tamper: null,
      last_seen: null,
      is_active: false,
    };
  }

  const is_active = is_device_active(latest.createdAt);

  return {
    contact: latest.contact,
    tamper: latest.data?.tamper || false,
    last_seen: latest.createdAt,
    is_active,
  };
};
const is_device_active = (last_seen) => {
  if (!last_seen) return false;

  const diff = Date.now() - new Date(last_seen).getTime();

  return diff < 60 * 60 * 1000; // 10 min
};
const get_bathroom_data = async (device_name) => {
  const today_start = new Date();
  today_start.setHours(0, 0, 0, 0);

  // Run both queries in parallel:
  //   - today's logs for enter/exit/visit tracking
  //   - most recent log ever for last_seen (cross-day, not just today)
  // _id:1 as secondary sort ensures correct insertion order when multiple logs
  // share the same createdAt millisecond (common during rapid testing).
  const [logs, latest_log] = await Promise.all([
    zigbee_log
      .find({ device_name, createdAt: { $gte: today_start }, type: 'motion' })
      .sort({ createdAt: 1, _id: 1 }),
    zigbee_log.findOne({ device_name, type: 'motion' }).sort({ createdAt: -1, _id: -1 }).lean(),
  ]);

  let last_entered = null;
  let last_exit = null;
  let visit_count = 0;
  let last_state = null;
  let current_state = false;

  for (const log of logs) {
    const time = log.createdAt;

    // ENTER: null/false → true
    if (log.occupancy === true && last_state !== true) {
      visit_count++;
      last_entered = time;
    }

    // EXIT: true → false
    if (log.occupancy === false && last_state === true) {
      last_exit = time;
    }

    last_state = log.occupancy;
  }

  current_state = last_state === true;

  const state = await alert_state.findOne({ key: device_name });

  const duration_min = state?.session_start
    ? (Date.now() - new Date(state.session_start).getTime()) / 60000
    : 0;

  return {
    occupancy: current_state,
    duration_min,
    visit_count,
    last_entered: last_entered ? last_entered.toISOString() : null,
    last_exit: last_exit ? last_exit.toISOString() : null,
    // last_seen is the absolute latest sensor activity (cross-day), kept
    // independent of last_entered so it doesn't collapse to the same value
    // when the most recent event is an enter transition.
    last_seen: latest_log ? latest_log.createdAt.toISOString() : null,
    alert_threshold: 30,
    alert_active: current_state && duration_min >= 30,
  };
};

/**
 * Format duration from decimal minutes to mm:ss
 */
const format_duration = (duration_min) => {
  const minutes = Math.floor(duration_min);
  const seconds = Math.floor((duration_min - minutes) * 60);
  return `${minutes}m ${seconds}s`;
};
const get_or_create_state = async (key, type) => {
  return await alert_state.findOneAndUpdate(
    { key },
    { $setOnInsert: { key, type } },
    { upsert: true, new: true },
  );
};

// =========================================
// MAIN CHECKER
// =========================================
let is_bathroom_alert_checker_running = false;
const start_bathroom_alert_checker = () => {
  cron.schedule('*/2 * * * * *', async () => {
    if (is_bathroom_alert_checker_running) {
      return;
    }
    is_bathroom_alert_checker_running = true;
    try {
      // Skip entirely when the hub is offline — no fresh sensor data is
      // arriving, so any running timer is stale and would fire a false alert.
      const offline_residents = await hub_service.get_offline_resident_ids();

      const devices = await device_model
        .find({
          type: 'Zigbee',
          status: 'active',
          $or: [{ sensor_type: 'motion' }, { zigbee_type: 'motion' }],
        })
        .lean();

      for (const device of devices) {
        try {
          // =====================================
          // VALIDATION
          // =====================================
          const key = device.id || device.zigbee_id;

          if (!key || !device?.resident) {
            continue;
          }

          // Hub offline — suppress alerts for this device's resident.
          if (offline_residents.has(String(device.resident))) continue;

          // =====================================
          // GET BATHROOM DATA
          // =====================================
          const data = await get_bathroom_data(key);

          if (!data) {
            continue;
          }

          // =====================================
          // GET RESIDENT
          // =====================================
          const resident_info = await resident.findById(device.resident).lean();

          if (!resident_info?.creator) {
            continue;
          }

          // =====================================
          // GET USER SOCKET
          // =====================================
          const user_info = await user.findById(resident_info.creator).select('socket_id').lean();

          if (!user_info?.socket_id) {
            continue;
          }

          const state = await get_or_create_state(key, 'bathroom');

          if (data.occupancy && !state.session_start) {
            await alert_state.updateOne({ key }, { session_start: new Date() });
            state.session_start = new Date();
          }

          if (!data.occupancy && state.session_start) {
            await alert_state.updateOne(
              { key },
              {
                session_start: null,
                last_alert_level: null,
                last_alert_time: null,
              },
            );
          }

          const duration_min = state.session_start
            ? (Date.now() - new Date(state.session_start).getTime()) / 60000
            : 0;

          const formatted_duration = format_duration(duration_min);

          // =====================================
          // LIVE UPDATE PAYLOAD
          // =====================================
          const live_payload = {
            ...data,

            duration: formatted_duration,

            duration_min: Number(duration_min.toFixed(2)),
          };

          // =====================================
          // SOCKET DEBUG
          // =====================================
          await add_socket_debug({
            type: 'socket_emit',
            event: 'bathroom_update',
            room: 'system',
            socket_id: user_info.socket_id,
            payload: live_payload,
            message: 'bathroom live update',
          });

          // =====================================
          // SOCKET EMIT
          // =====================================
          socket_service.send_to_user(user_info._id.toString(), 'bathroom_update', live_payload);

          // =====================================
          // STOP ALERTS IF NOT OCCUPIED
          // =====================================
          if (!data.occupancy) {
            continue;
          }

          // =====================================
          // ALERT THRESHOLDS
          // =====================================
          const thresholds = testing_flag
            ? [
                {
                  time: 3,
                  label: 'warning',
                },
                {
                  time: 3.5,
                  label: 'danger',
                },
                {
                  time: 4,
                  label: 'emergency',
                },
              ]
            : alert_levels;

          // =====================================
          // FIND ALERT LEVEL
          // =====================================
          let alert_type = null;

          for (let i = thresholds.length - 1; i >= 0; i--) {
            if (duration_min >= thresholds[i].time) {
              alert_type = thresholds[i].label;
              break;
            }
          }

          // =====================================
          // NO ALERT
          // =====================================
          if (!alert_type) {
            continue;
          }

          // =====================================
          // ALERT PRIORITY
          // =====================================
          const priority = {
            warning: 1,
            danger: 2,
            emergency: 3,
          };

          const { last_alert_level, last_alert_time } = state;

          if (last_alert_level) {
            if (priority[alert_type] < priority[last_alert_level]) continue;
            if (
              priority[alert_type] === priority[last_alert_level] &&
              Date.now() - new Date(last_alert_time).getTime() < 5 * 60 * 1000
            )
              continue;
          }

          await alert_state.updateOne(
            { key },
            {
              last_alert_level: alert_type,
              last_alert_time: new Date(),
            },
          );

          // =====================================
          // ALERT PAYLOAD
          // =====================================
          const alert_payload = {
            device: key,

            alert: alert_type,

            duration: formatted_duration,

            duration_min: Number(duration_min.toFixed(2)),

            time: new Date().toISOString(),
          };

          // =====================================
          // DEBUG ALERT
          // =====================================
          await add_socket_debug({
            type: 'socket_emit',
            event: 'bathroom_alert',
            room: 'system',
            socket_id: user_info.socket_id,
            payload: alert_payload,
            message: 'bathroom alert triggered',
          });
          // Use the device's actual room label (falls back to "room" -- not
          // the literal word "bathroom" -- when unset), so this alert reads
          // correctly for any room this motion sensor happens to be
          // installed in, not just a bathroom.
          const room_label = device.room || 'room';
          await alert_log.create({
            title: 'Room Occupancy Alert',
            description: `Resident in ${room_label} for ${formatted_duration}`,
            resident: resident_info._id,
            device: device._id,
            device_type: 'zigbee',
            alert_level: alert_type,
            meta: { duration_min: +duration_min.toFixed(2), room: room_label },
          });
          // =====================================
          // EMIT ALERT
          // =====================================
          socket_service.send_to_user(user_info._id.toString(), 'bathroom_alert', alert_payload);
        } catch (device_error) {
          await add_socket_debug({
            type: 'device_error',
            event: 'bathroom_checker_device_error',
            room: 'system',
            socket_id: null,
            payload: {
              message: device_error.message,
              stack: device_error.stack,
            },
            message: 'device checker failed',
          });
        }
      }
    } catch (error) {
      await add_socket_debug({
        type: 'system_error',
        event: 'bathroom_alert_checker_error',
        room: 'system',
        socket_id: null,
        payload: {
          message: error.message,
          stack: error.stack,
        },
        message: 'bathroom checker crashed',
      });
    } finally {
      is_bathroom_alert_checker_running = false;
    }
  });
};
const start_emfit_alert_checker = () => {
  cron.schedule(
    '* * * * *',
    async () => {
      // Hub offline — no fresh vital data, skip to avoid stale alerts.
      const offline_residents = await hub_service.get_offline_resident_ids();

      const devices = await get_devices({ type: 'Emfit', status: 'active' });

      for (const device of devices) {
        // Hub offline — suppress alerts for this device's resident.
        if (device.resident && offline_residents.has(String(device.resident))) continue;
        const latest = await emfit_logs
          .findOne({ serialnumber: device.sr_num })
          .sort({ createdAt: -1 })
          .lean();

        if (!latest) continue;

        const heart_rate = parseFloat(latest.heart_rate);
        const respiration = parseFloat(latest.respiration_rate);

        const timestamp = new Date(latest.date_occurred || latest.createdAt);

        // ✅ freshness check (VERY IMPORTANT)
        const diff = Date.now() - timestamp.getTime();
        if (diff > 10 * 60 * 1000) continue; // older than 10 min → ignore

        // ✅ skip alerts when person is NOT on bed
        // When GLK device is online but no one is on the bed, it reports
        // HR=0 and RR=0. This is valid organic data, not an emergency.
        // Only evaluate alerts for non-zero readings (person actually in bed).
        if (heart_rate === 0 && respiration === 0) continue;
        if (heart_rate === 0 || respiration === 0) {
          // One is zero, other is non-zero — edge case (sensor transitioning
          // in/out of bed). Skip alerts to avoid false positives.
          continue;
        }

        // ✅ sensor settling cooldown — skip alerts for 2 min after getting on pad
        // GLK sensor needs ~90-120s to calibrate breathing/heart rate after
        // someone lies down. Initial readings are unreliable (e.g. RR=9 that
        // settles to RR=18 within 90 seconds). Suppress vital alerts until
        // the sensor has had time to stabilize.
        const last_off_bed = await emfit_logs
          .findOne({ serialnumber: device.sr_num, in_bed: false })
          .sort({ createdAt: -1 })
          .lean();

        if (last_off_bed) {
          const settling_ms = Date.now() - new Date(last_off_bed.createdAt).getTime();
          if (settling_ms < 2 * 60 * 1000) {
            // Person got on pad less than 2 min ago — sensor still settling
            continue;
          }
        }

        // ✅ evaluate alerts
        const hr_alert = get_alert_level(heart_rate, vital_thresholds.heart_rate);
        const rr_alert = get_alert_level(respiration, vital_thresholds.respiration);

        // pick highest severity
        const priority = { normal: 1, danger: 2, critical: 3 };

        let final_alert = null;

        if (hr_alert || rr_alert) {
          final_alert = priority[hr_alert] > priority[rr_alert] ? hr_alert : rr_alert;
        }

        if (!final_alert || final_alert === 'normal') continue;

        const state = await get_or_create_state(device.sr_num, 'vital');

        if (
          state.last_vital_alert_time &&
          Date.now() - new Date(state.last_vital_alert_time).getTime() < 5 * 60 * 1000
        )
          continue;

        await alert_state.updateOne({ key: device.sr_num }, { last_vital_alert_time: new Date() });

        // `device.resident` is a RESIDENT id, not a user id -- resolve the
        // resident's owning user for the mute check, socket emit, and push.
        // (Previously this called `user.findById(device.resident)`, which
        // looked up the wrong collection and silently never matched, so the
        // socket branch below never fired. Fixed as part of wiring push.)
        const resident_doc = await resident.findById(device.resident).lean();
        const resident_info = resident_doc?.creator
          ? await user
              .findById(resident_doc.creator)
              .select('socket_id _id notifications_enabled muted_alert_devices')
              .lean()
          : null;

        // Device-wise alert mute (GLK/Emfit) -- independent from push mute,
        // which dispatch_notification checks separately below. When muted,
        // skip the alert_log entry and socket emit entirely for this
        // reading (no in-app record), per product decision.
        if (!is_alert_muted(resident_info, DeviceCategory.GLK_EMFIT)) {
          await alert_log.create({
            title: 'Vital Signs Alert',
            description: `Abnormal vitals — HR: ${heart_rate}, RR: ${respiration}`,
            resident: device.resident,
            device: device._id,
            device_type: 'emfit',
            alert_level: final_alert,
            meta: { heart_rate, respiration },
          });

          if (resident_info?.socket_id) {
            socket_service.send_to_user(resident_info._id.toString(), 'emfit_alert', {
              device: device.sr_num,
              alert: final_alert,
              vitals: {
                heart_rate,
                respiration,
              },
              time: new Date().toISOString(),
            });
          }
        }

        // Push (matrix rows #9-#12, GLK elevated/low HR + high/low RR).
        // Which vital actually drove `final_alert` (HR wins ties, matching
        // the `priority[hr_alert] > priority[rr_alert]` comparison above).
        if (resident_info?._id) {
          const hr_drove_it = hr_alert && priority[hr_alert] >= priority[rr_alert || 'normal'];
          const direction = hr_drove_it
            ? get_vital_direction(heart_rate, vital_thresholds.heart_rate)
            : get_vital_direction(respiration, vital_thresholds.respiration);

          const backend_event = hr_drove_it
            ? direction === 'low'
              ? 'GLK_LOW_HEART_RATE'
              : 'GLK_ELEVATED_HEART_RATE'
            : direction === 'low'
              ? 'GLK_LOW_RESPIRATORY_RATE'
              : 'GLK_HIGH_RESPIRATORY_RATE';

          await dispatch_notification({
            backend_event,
            user_id: resident_info._id,
            // Title/body now come from the catalog's standardized copy
            // (VAYUZ_AwesomLiving_NotificationMatrix_FINAL_v3) via
            // template_vars, e.g. "High Heart Rate" / "{resident}'s heart
            // rate has been elevated above their normal range..." --
            // replacing the old ad hoc "Urgent vitals alert" / raw
            // "Heart rate 72 bpm" copy. The numeric reading is still in
            // `data.heart_rate`/`data.respiration` for the app's vitals
            // screen, just not baked into the push text anymore.
            template_vars: {
              resident: resident_doc?.name || 'Resident',
              residentId: resident_info._id.toString(),
            },
            data: {
              device: device.sr_num,
              resident: device.resident?.toString(),
              heart_rate,
              respiration,
            },
            // GLK_ELEVATED_HEART_RATE etc. are P2 ("warning") in the static
            // catalog, but a single reading can be the extreme/critical
            // tier -- override the severity per-call so the push gets the
            // app's loud channel/sound (data.severity 'critical') instead
            // of the default P2 mapping ('warning').
            severity: final_alert === 'critical' ? 'critical' : 'warning',
            // Matrix: "Quiet-hours: N (if critical)" -- only the critical
            // (extreme) tier bypasses quiet hours; the base "danger" tier
            // respects them like any other P2 warning.
            bypass_quiet_hours: final_alert === 'critical',
          });
        }
      }
    },
    60 * 1000,
  );
};
const find_recent_zigbee_log = async ({ device, type, action }) => {
  const three_seconds_ago = new Date(Date.now() - 1000);
  return await zigbee_log.findOne({
    device_name: device,
    type,
    action,
    createdAt: { $gte: three_seconds_ago },
  });
};

// =========================================
// CONTACT (DOOR/WINDOW) ALERT CHECKER
// =========================================

/**
 * Returns current time as "HH:MM" string in IST (UTC+5:30).
 * Render.com runs in UTC, but monitoring windows are configured by IST users.
 */
const get_current_time_str = () => {
  const now = new Date();
  const ist_ms = now.getTime() + (5 * 60 + 30) * 60 * 1000;
  const ist = new Date(ist_ms);
  const h = String(ist.getUTCHours()).padStart(2, '0');
  const m = String(ist.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
};

/**
 * Returns true when current_time falls within the [from, to] window.
 * Handles overnight windows (e.g. "22:00" → "06:00").
 */
const is_within_window = (current, from, to) => {
  if (from <= to) return current >= from && current <= to;
  // overnight: e.g. 22:00 to 06:00
  return current >= from || current <= to;
};

/**
 * Alert flow for Zigbee contact (door/window) sensors:
 *   open  →  info alert immediately
 *   +5min, not resolved  →  warning alert
 *   +5min more, not resolved  →  emergency alert
 *   close  →  session reset (auto-resolved by handler in zigbee_service)
 *
 * Runs every 30 s. Testing flag shortens thresholds to seconds.
 */
const start_contact_alert_checker = () => {
  cron.schedule('*/30 * * * * *', async () => {
    try {
      // Hub offline — no fresh sensor data, skip to avoid false alerts.
      const offline_residents = await hub_service.get_offline_resident_ids();

      const devices = await device_model
        .find({
          type: 'Zigbee',
          $or: [
            { sensor_type: 'contact' },
            { sensor_type: 'door & window' },
            { zigbee_type: 'contact' },
          ],
        })
        .lean();

      for (const device of devices) {
        try {
          const key = device.id || device.zigbee_id;
          if (!key || !device?.resident) continue;
          if (device.status !== 'active') continue;

          // Hub offline — suppress alerts for this device's resident.
          if (offline_residents.has(String(device.resident))) continue;

          // ── Monitoring time-window check ──────────────────────────────
          // Only fire alerts when an active settings record exists AND the
          // current time falls inside the configured window. When no active
          // settings exist the user hasn't enabled monitoring — skip entirely.
          const settings = await contact_alert_settings.findOne({
            device: device._id,
            is_active: true,
          });

          if (!settings) {
            // No active monitoring — skip this device entirely.
            continue;
          }

          const now_str = get_current_time_str();
          const in_window = is_within_window(now_str, settings.monitor_from, settings.monitor_to);

          // ── Current contact state ─────────────────────────────────────
          const contact_data = await get_contact_data(key);

          // contact=false → door/window OPEN; contact=true → CLOSED
          const is_open = contact_data?.contact === false;

          const state = await get_or_create_state(key, 'contact');

          console.log(
            `[contact-cron] key=${key} is_open=${is_open} in_window=${in_window} last_level=${state.last_alert_level} session_start=${state.session_start}`,
          );

          if (!is_open) {
            // Door closed — always reset state regardless of session_start
            if (state.session_start || state.last_alert_level) {
              await alert_state.updateOne(
                { key },
                {
                  session_start: null,
                  last_alert_level: null,
                  last_alert_time: null,
                  last_alert_log_id: null,
                },
              );
              console.log(`[contact-cron] key=${key} state reset (door closed)`);
            }
            continue;
          }

          // ── Outside monitoring window — do NOT start session or alert ──
          if (!in_window) {
            // If a session was already running (door opened inside window,
            // still open when window ended), freeze escalation but keep the
            // session so it resumes when the window opens again.
            console.log(
              `[contact-cron] key=${key} outside window (${settings.monitor_from}-${settings.monitor_to}, now=${now_str}) — skipping`,
            );
            continue;
          }

          // ── Door is open AND inside monitoring window ──────────────────
          if (!state.session_start) {
            await alert_state.updateOne({ key }, { session_start: new Date() });
            state.session_start = new Date();
          }

          const duration_min = (Date.now() - new Date(state.session_start).getTime()) / 60000;
          const formatted_duration = format_duration(duration_min);

          // Thresholds (minutes): 0 = info, 5 = warning, 10 = emergency
          const thresholds = testing_flag
            ? [
                { time: 0, label: 'info' },
                { time: 0.5, label: 'warning' }, // 30 s for testing
                { time: 1, label: 'emergency' }, // 60 s for testing
              ]
            : [
                { time: 0, label: 'info' },
                { time: 5, label: 'warning' },
                { time: 10, label: 'emergency' },
              ];

          const priority = { info: 1, warning: 2, emergency: 3 };
          const last_priority = state.last_alert_level ? priority[state.last_alert_level] : 0;

          // Find the NEXT level above what was last sent whose threshold has been crossed.
          // Iterating low→high ensures we escalate one step at a time (info before warning,
          // warning before emergency) even when multiple thresholds are crossed at once.
          let target_level = null;
          for (let i = 0; i < thresholds.length; i++) {
            if (
              priority[thresholds[i].label] > last_priority &&
              duration_min >= thresholds[i].time
            ) {
              target_level = thresholds[i].label;
              break;
            }
          }
          console.log(
            `[contact-cron] key=${key} duration=${duration_min.toFixed(2)}min target_level=${target_level} last=${state.last_alert_level}`,
          );
          if (!target_level) {
            // All escalation levels sent. If emergency is still unresolved, repeat it
            // at the same interval until the user resolves it.
            if (
              state.last_alert_level === 'emergency' &&
              state.last_alert_log_id &&
              state.last_alert_time
            ) {
              const repeat_interval_min = testing_flag ? 0.5 : 5;
              const since_last_min =
                (Date.now() - new Date(state.last_alert_time).getTime()) / 60000;
              if (since_last_min >= repeat_interval_min) {
                const prev = await alert_log.findById(state.last_alert_log_id).lean();
                if (prev && !prev.is_resolved) {
                  target_level = 'emergency';
                } else {
                  // Previous emergency was resolved (door closed or user resolved it).
                  // Reset the session so a fresh info→warning→emergency cycle can begin.
                  await alert_state.updateOne(
                    { key },
                    {
                      session_start: null,
                      last_alert_level: null,
                      last_alert_time: null,
                      last_alert_log_id: null,
                    },
                  );
                }
              }
            }
            if (!target_level) {
              console.log(
                `[contact-cron] key=${key} SKIPPED — already at ${state.last_alert_level}`,
              );
              continue;
            }
          }

          // For warning/emergency: check if the previous alert was already resolved by the user.
          // If user resolved it, stop escalating and reset the session.
          if (state.last_alert_log_id && priority[target_level] > 1) {
            const prev = await alert_log.findById(state.last_alert_log_id).lean();
            if (prev?.is_resolved) {
              await alert_state.updateOne(
                { key },
                {
                  session_start: null,
                  last_alert_level: null,
                  last_alert_time: null,
                  last_alert_log_id: null,
                },
              );
              continue;
            }
          }

          // ── Fetch resident & user ─────────────────────────────────────
          const resident_info = await resident.findById(device.resident).lean();
          if (!resident_info?.creator) continue;

          const user_info = await user
            .findById(resident_info.creator)
            .select('socket_id _id notifications_enabled muted_alert_devices')
            .lean();

          // ── Create alert_log entry ────────────────────────────────────
          // (Always created, even if the device's in-app alert is muted --
          // the escalation state machine above keys off last_alert_log_id
          // and the resolve-alert flow reads from this collection. Only the
          // real-time socket emit and the push are gated by mute state.)
          const titles = {
            info: 'Door/Window Opened',
            warning: 'Door/Window Open – Warning',
            emergency: 'Door/Window Open – Emergency',
          };

          const new_alert = await alert_log.create({
            title: titles[target_level],
            description: `Door/Window has been open for ${formatted_duration}`,
            resident: resident_info._id,
            device: device._id,
            device_type: 'zigbee',
            alert_level: target_level,
            is_resolved: false,
            meta: {
              duration_min: +duration_min.toFixed(2),
              sensor_type: device.sensor_type || 'contact',
              room: device.room,
            },
          });

          // ── Update alert state ────────────────────────────────────────
          await alert_state.updateOne(
            { key },
            {
              last_alert_level: target_level,
              last_alert_time: new Date(),
              last_alert_log_id: new_alert._id,
            },
          );

          // ── Emit socket alert ─────────────────────────────────────────
          if (!is_alert_muted(user_info, DeviceCategory.WINDOW_DOOR)) {
            socket_service.send_to_user(user_info._id.toString(), 'contact_alert', {
              device: key,
              alert: target_level,
              duration: formatted_duration,
              duration_min: +duration_min.toFixed(2),
              time: new Date().toISOString(),
              room: device.room || null,
              alert_log_id: new_alert._id,
            });
          }

          // Push (matrix #20/#23, DOOR_LEFT_OPEN / WINDOW_LEFT_OPEN, P2) --
          // only at warning/emergency. The initial "info" (just opened)
          // stays feed/socket-only, matching the matrix's DOOR_OPENED /
          // WINDOW_OPENED rows being feed-only.
          if (target_level !== 'info' && user_info?._id) {
            const is_window = classify_contact_device(device) === 'window';
            await dispatch_notification({
              backend_event: is_window ? 'WINDOW_LEFT_OPEN' : 'DOOR_LEFT_OPEN',
              user_id: user_info._id,
              // Title/body from the catalog's standardized copy (FINAL_v3),
              // e.g. "Window Left Open" / "The {location} window has been
              // open for a while." -- the exact open duration is no longer
              // baked into the push text (matrix's simplified copy), but
              // stays available in data.alert_level / the deep-linked device
              // screen.
              template_vars: {
                location: device.room || (is_window ? 'window' : 'door'),
                deviceId: device._id ? device._id.toString() : undefined,
              },
              data: {
                device: key,
                resident: resident_info._id.toString(),
                room: device.room || null,
                alert_log_id: new_alert._id.toString(),
                alert_level: target_level,
              },
            });
          }
        } catch (device_error) {
          await add_socket_debug({
            type: 'device_error',
            event: 'contact_checker_device_error',
            room: 'system',
            socket_id: null,
            payload: {
              message: device_error.message,
              stack: device_error.stack,
            },
            message: 'contact checker device failed',
          });
        }
      }
    } catch (error) {
      await add_socket_debug({
        type: 'system_error',
        event: 'contact_alert_checker_error',
        room: 'system',
        socket_id: null,
        payload: {
          message: error.message,
          stack: error.stack,
        },
        message: 'contact checker crashed',
      });
    }
  });
};

// =========================================
// ROOM STATE QUERY
// =========================================

/**
 * Returns the current room_state for a given device (motion or presence sensor).
 * Looks up by (resident, room) derived from the device record.
 */
const get_room_state = async (device_id) => {
  const device = await device_model.findById(device_id).lean();
  if (!device) return null;
  return await room_state_model
    .findOne({ resident: device.resident, room: device.room || 'bathroom' })
    .lean();
};

// =========================================
// MOTION + PRESENCE NO-MOTION ALERT CHECKER
// =========================================

/**
 * Alert flow for combined motion + presence sensors:
 *   Presence=TRUE + Motion stale > threshold_min  →  warning alert
 *   Warning unresolved + escalation_delay_min more  →  emergency alert
 *   Presence=FALSE  →  session reset (handled in zigbee_service)
 *
 * Runs every 30 s. Testing flag shortens thresholds to 1 min / 0.5 min escalation.
 */
const start_room_alert_checker = () => {
  cron.schedule('*/30 * * * * *', async () => {
    try {
      // Hub offline — no fresh sensor data, skip to avoid false alerts.
      const offline_residents = await hub_service.get_offline_resident_ids();

      // Only process rooms where presence is active and the no-motion timer has started
      const active_rooms = await room_state_model
        .find({
          presence_active: true,
          no_motion_timer_start: { $ne: null },
        })
        .lean();

      for (const rs of active_rooms) {
        try {
          const presence_device_id = rs.presence_device;
          if (!presence_device_id) continue;

          const device = await device_model.findById(presence_device_id).lean();
          if (!device || device.status !== 'active') continue;

          // Hub offline — suppress alerts for this device's resident.
          if (device.resident && offline_residents.has(String(device.resident))) continue;

          // ── Load per-device alert config ──────────────────────────────
          const settings = await no_motion_settings
            .findOne({ device: presence_device_id, is_active: true })
            .lean();

          let threshold_min = settings?.threshold_min ?? 20;
          const escalation_delay_min = settings?.escalation_delay_min ?? 10;

          // Night mode threshold override
          if (settings?.night_mode_enabled) {
            const now_str = get_current_time_str();
            if (
              is_within_window(
                now_str,
                settings.night_from || '22:00',
                settings.night_to || '06:00',
              )
            ) {
              threshold_min = settings.night_threshold_min ?? 60;
            }
          }

          // Shorten for testing
          const effective_threshold = testing_flag ? 1 : threshold_min;
          const effective_escalation = testing_flag ? 0.5 : escalation_delay_min;

          const since_no_motion =
            (Date.now() - new Date(rs.no_motion_timer_start).getTime()) / 60000;

          const priority = { warning: 1, emergency: 2 };
          const last_priority = rs.no_motion_alert_level ? priority[rs.no_motion_alert_level] : 0;

          const thresholds = [
            { time: effective_threshold, label: 'warning' },
            { time: effective_threshold + effective_escalation, label: 'emergency' },
          ];

          let target_level = null;
          for (const t of thresholds) {
            if (priority[t.label] > last_priority && since_no_motion >= t.time) {
              target_level = t.label;
              break;
            }
          }

          if (!target_level) {
            // No new escalation level — check if the current alert should be repeated.
            // Repeat interval is fixed at 5 min (0.5 min in testing mode).
            const repeat_interval_min = testing_flag ? 0.5 : 5;
            if (rs.no_motion_alert_level && rs.no_motion_alert_time && rs.no_motion_alert_log_id) {
              const since_last_alert =
                (Date.now() - new Date(rs.no_motion_alert_time).getTime()) / 60000;

              if (since_last_alert >= repeat_interval_min) {
                const prev = await alert_log.findById(rs.no_motion_alert_log_id).lean();
                if (prev && !prev.is_resolved) {
                  // Unresolved — repeat the same level
                  target_level = rs.no_motion_alert_level;
                } else {
                  // Resolved by user — reset so a fresh cycle can begin
                  await room_state_model.updateOne(
                    { _id: rs._id },
                    {
                      no_motion_alert_level: null,
                      no_motion_alert_time: null,
                      no_motion_alert_log_id: null,
                    },
                  );
                }
              }
            }
            if (!target_level) continue;
          }

          // For escalation (warning → emergency): if the previous alert was already
          // resolved by the user, reset rather than escalate to a higher level.
          if (
            rs.no_motion_alert_log_id &&
            priority[target_level] >
              (rs.no_motion_alert_level ? priority[rs.no_motion_alert_level] : 0)
          ) {
            const prev = await alert_log.findById(rs.no_motion_alert_log_id).lean();
            if (prev?.is_resolved) {
              await room_state_model.updateOne(
                { _id: rs._id },
                {
                  no_motion_alert_level: null,
                  no_motion_alert_time: null,
                  no_motion_alert_log_id: null,
                },
              );
              continue;
            }
          }

          // ── Fetch resident & user ─────────────────────────────────────
          const resident_info = await resident.findById(rs.resident).lean();
          if (!resident_info?.creator) continue;

          const user_info = await user
            .findById(resident_info.creator)
            .select('socket_id _id notifications_enabled muted_alert_devices')
            .lean();

          // ── Create alert_log entry ────────────────────────────────────
          // (Always created even if muted -- escalation state + resolve-alert
          // flow key off last_alert_log_id. Only the socket emit + push are
          // gated by mute state.)
          const titles = {
            warning: 'No Motion Detected – Warning',
            emergency: 'No Motion Detected – Emergency',
          };

          const formatted_duration = format_duration(since_no_motion);
          const room_name = rs.room || device.room || 'Room';

          const new_alert = await alert_log.create({
            title: titles[target_level],
            description: `${room_name} – no motion for ${formatted_duration} while presence is active`,
            resident: resident_info._id,
            device: presence_device_id,
            device_type: 'zigbee',
            alert_level: target_level,
            is_resolved: false,
            meta: {
              duration_min: +since_no_motion.toFixed(2),
              sensor_type: 'presence',
              room: room_name,
            },
          });

          // ── Update room state ─────────────────────────────────────────
          await room_state_model.updateOne(
            { _id: rs._id },
            {
              no_motion_alert_level: target_level,
              no_motion_alert_time: new Date(),
              no_motion_alert_log_id: new_alert._id,
            },
          );

          // ── Emit socket alert ─────────────────────────────────────────
          if (user_info?._id && !is_alert_muted(user_info, DeviceCategory.MOTION_PRESENCE)) {
            socket_service.send_to_user(user_info._id.toString(), 'no_motion_alert', {
              room: room_name,
              alert: target_level,
              duration: formatted_duration,
              duration_min: +since_no_motion.toFixed(2),
              time: new Date().toISOString(),
              alert_log_id: new_alert._id,
            });
          }

          // Push (matrix #2, INACTIVITY_POSSIBLE_FALL, P1) -- only at the
          // final "emergency" escalation tier. The earlier "warning" tier
          // stays feed/socket-only: pushing on every warning is exactly the
          // v1 over-notification the matrix is designed to stop. See
          // notification_events.js #2 for the baseline/speaker-check gap
          // this simplified wiring doesn't yet cover.
          if (target_level === 'emergency' && user_info?._id) {
            await dispatch_notification({
              backend_event: 'INACTIVITY_POSSIBLE_FALL',
              user_id: user_info._id,
              // Title/body from the catalog's standardized copy (FINAL_v3):
              // "Possible Fall / No Movement Detected" / "{resident} hasn't
              // moved in {location} longer than usual. We checked in --
              // please verify." Duration is still in data.duration_min for
              // the app's timeline screen.
              template_vars: {
                resident: resident_info?.name || 'Resident',
                location: room_name,
                residentId: resident_info?._id ? resident_info._id.toString() : undefined,
              },
              data: {
                resident: resident_info._id.toString(),
                room: room_name,
                alert_log_id: new_alert._id.toString(),
                duration_min: +since_no_motion.toFixed(2),
              },
            });
          }

          console.log(
            `[room-cron] room=${room_name} no_motion=${since_no_motion.toFixed(2)}min target_level=${target_level}`,
          );
        } catch (room_error) {
          console.error('[room-cron] room error:', room_error.message);
        }
      }
    } catch (error) {
      console.error('[room-cron] checker crashed:', error.message);
    }
  });
};

// =========================================================================
// DEVICE OFFLINE CHECKER  (notification matrix row 39 — DEVICE_OFFLINE)
//
// Runs every 5 minutes. For every active device whose last zigbee_log is
// older than 1 hour (the existing is_device_active threshold), fires a
// DEVICE_OFFLINE push. Repeats every 30 minutes while the device stays
// offline, using alert_state to track the last notification time.
// Quiet-hours exempt: No (per matrix). When a device comes back online
// (new zigbee_log arrives), the alert_state is auto-cleared so no
// resolved notification fires — the device just silently reappears.
// =========================================================================
const device_offline_repeat_ms = 30 * 60 * 1000; // 30 min repeat

const start_device_offline_checker = () => {
  cron.schedule('*/5 * * * *', async () => {
    try {
      // Hub offline — when the Pi is down ALL sensors will appear offline,
      // but that's already covered by HUB_OFFLINE (row 35). Don't spam
      // individual DEVICE_OFFLINE pushes on top of it.
      const offline_residents = await hub_service.get_offline_resident_ids();

      // All active Zigbee devices (motion, presence, contact, switch).
      const devices = await device_model.find({ type: 'Zigbee', status: 'active' }).lean();

      for (const device of devices) {
        try {
          const key = device.id || device.zigbee_id;
          if (!key || !device?.resident) continue;

          // Hub offline — suppress per-sensor alerts for this resident.
          if (offline_residents.has(String(device.resident))) continue;

          // Find the most recent zigbee_log for this device.
          const latest_log = await zigbee_log
            .findOne({ device_name: key })
            .sort({ createdAt: -1 })
            .select('createdAt')
            .lean();

          const last_seen = latest_log?.createdAt;
          const is_active = is_device_active(last_seen);

          if (is_active) {
            // Device is online — clear any existing offline alert_state.
            await alert_state.updateOne(
              { key: `offline:${key}` },
              { $set: { last_alert_time: null, last_alert_level: null } },
            );
            continue;
          }

          // Device is offline (no data in > 1 hour).
          const state = await get_or_create_state(`offline:${key}`, 'device_offline');

          // Check 30-min repeat cooldown.
          if (
            state.last_alert_time &&
            Date.now() - new Date(state.last_alert_time).getTime() < device_offline_repeat_ms
          ) {
            continue;
          }

          // Resolve resident + user for push.
          const resident_info = await resident.findById(device.resident).lean();
          if (!resident_info?.creator) continue;

          const user_info = await user
            .findById(resident_info.creator)
            .select('_id notifications_enabled muted_push_devices')
            .lean();
          if (!user_info?._id) continue;

          // Build a human-readable device name from room + sensor_type.
          const device_name = [device.room, device.sensor_type || 'sensor']
            .filter(Boolean)
            .join(' ')
            .replace(/^\w/, (c) => c.toUpperCase());

          // Update alert_state BEFORE dispatching so a crash doesn't re-fire
          // within the same 30-min window.
          await alert_state.updateOne(
            { key: `offline:${key}` },
            { $set: { last_alert_time: new Date(), last_alert_level: 'warning' } },
          );

          await dispatch_notification({
            backend_event: 'DEVICE_OFFLINE',
            user_id: user_info._id,
            template_vars: {
              deviceName: device_name,
              deviceId: device._id ? device._id.toString() : undefined,
            },
            data: {
              device: key,
              resident: resident_info._id.toString(),
              sensor_type: device.sensor_type || null,
              room: device.room || null,
              last_seen: last_seen ? last_seen.toISOString() : null,
            },
          });

          console.log(
            `📡 DEVICE_OFFLINE notification: ${key} (${device_name}) — last seen ${last_seen ? last_seen.toISOString() : 'never'}`,
          );
        } catch (device_error) {
          console.error('[device-offline-cron] device error:', device_error.message);
        }
      }
    } catch (error) {
      console.error('[device-offline-cron] checker crashed:', error.message);
    }
  });
};

// =========================================================================
// Camera offline checker (CpPlus cameras via Pi heartbeat)
// Runs every 30s. If a camera's camera_last_seen is older than 2 min,
// fires CAMERA_OFFLINE push. When heartbeat resumes, fires CAMERA_ONLINE.
// =========================================================================
const camera_offline_threshold_ms = 2 * 60 * 1000; // 2 minutes
const camera_offline_repeat_ms = 30 * 60 * 1000; // 30 min repeat

let is_camera_checker_running = false;

// Throttle diagnostic summary to once every ~5 min (10 ticks × 30s).
let _cam_diag_tick = 0;

const start_camera_health_checker = () => {
  cron.schedule('*/30 * * * * *', async () => {
    if (is_camera_checker_running) return;
    is_camera_checker_running = true;
    _cam_diag_tick++;
    const log_diag = _cam_diag_tick % 10 === 1; // first tick + every 10th
    try {
      // Hub offline — suppress camera alerts for residents whose hub is down.
      const offline_residents = await hub_service.get_offline_resident_ids();

      // All active CpPlus cameras.
      const cameras = await device_model.find({ type: 'CpPlus', status: 'active' }).lean();

      const now = Date.now();

      // ── Diagnostic summary (every ~5 min) ──
      if (log_diag) {
        console.log(
          `[camera-cron] ── DIAG ── active CpPlus cameras: ${cameras.length}, offline_residents: [${[...offline_residents].join(', ')}]`,
        );
        for (const c of cameras) {
          const age = c.camera_last_seen
            ? Math.round((now - new Date(c.camera_last_seen).getTime()) / 1000)
            : null;
          console.log(
            `[camera-cron]   cam ${c.stream_name || c._id} | resident=${c.resident} | hub_id=${c.hub_id || 'NULL'} | last_seen=${age != null ? age + 's ago' : 'NEVER'} | status=${c.status}`,
          );
        }
      }

      if (!cameras.length && log_diag) {
        console.log(
          '[camera-cron] ⚠ No active CpPlus devices in DB — camera health check is a no-op. ' +
            'Ensure the CpPlus device exists in the devices collection with type="CpPlus" and status="active".',
        );
      }

      for (const camera of cameras) {
        try {
          if (!camera?.resident) {
            if (log_diag)
              console.log(`[camera-cron] SKIP ${camera.stream_name || camera._id}: no resident`);
            continue;
          }

          // Hub offline — suppress per-camera alerts for this resident.
          if (offline_residents.has(String(camera.resident))) {
            if (log_diag) {
              console.log(
                `[camera-cron] SKIP ${camera.stream_name || camera._id}: resident ${camera.resident} hub is OFFLINE (camera alerts suppressed)`,
              );
            }
            continue;
          }

          const last_seen = camera.camera_last_seen;
          const age_ms = last_seen ? now - new Date(last_seen).getTime() : null;
          const is_online = last_seen && age_ms < camera_offline_threshold_ms;

          const state_key = `camera_offline:${camera._id}`;

          if (is_online) {
            // Camera is online — check if it was previously offline (alert_state exists with a last_alert_time).
            const existing_state = await alert_state.findOne({ key: state_key }).lean();
            if (existing_state?.last_alert_time) {
              // Camera just came back online — clear alert_state and fire CAMERA_ONLINE feed.
              await alert_state.updateOne(
                { key: state_key },
                { $set: { last_alert_time: null, last_alert_level: null } },
              );

              // Resolve resident + user for notification.
              const resident_info = await resident.findById(camera.resident).lean();
              if (resident_info?.creator) {
                const camera_name = camera.stream_name || camera.room || 'Camera';

                console.log(
                  `[camera-cron] CAMERA_ONLINE: dispatching push for ${camera_name} (${camera._id})`,
                );

                const result = await dispatch_notification({
                  backend_event: 'CAMERA_ONLINE',
                  user_id: resident_info.creator,
                  template_vars: {
                    cameraName: camera_name,
                    deviceId: camera._id ? camera._id.toString() : undefined,
                  },
                  data: {
                    device_id: camera._id ? camera._id.toString() : null,
                    camera_name,
                  },
                }).catch((err) => {
                  console.error('[camera-cron] CAMERA_ONLINE notification failed:', err.message);
                  return { sent: false, reason: 'dispatch_error' };
                });

                console.log(
                  `[camera-cron] CAMERA_ONLINE dispatch result: ${JSON.stringify(result)}`,
                );

                // Emit socket event for real-time UI update.
                const user_info = await user.findById(resident_info.creator).select('_id').lean();
                if (user_info?._id) {
                  socket_service.send_to_user(String(user_info._id), 'camera_status', {
                    device_id: camera._id ? camera._id.toString() : null,
                    status: 'online',
                    camera_name,
                    last_seen: last_seen ? new Date(last_seen).toISOString() : null,
                  });
                }

                console.log(
                  `[camera-cron] CAMERA_ONLINE: ${camera_name} (${camera._id}) is back online`,
                );
              }
            }
            continue;
          }

          // Camera is offline (no heartbeat in > 2 minutes).
          const state = await get_or_create_state(state_key, 'camera_offline');

          // Skip if we already notified for this offline session (only notify once).
          if (state.last_alert_time) {
            if (log_diag) {
              console.log(
                `[camera-cron] SKIP ${camera.stream_name || camera._id}: already notified OFFLINE at ${new Date(state.last_alert_time).toISOString()} (won't re-notify until camera comes back online)`,
              );
            }
            continue;
          }

          // Resolve resident + user for push.
          const resident_info = await resident.findById(camera.resident).lean();
          if (!resident_info?.creator) {
            console.log(
              `[camera-cron] SKIP ${camera.stream_name || camera._id}: resident ${camera.resident} has no creator`,
            );
            continue;
          }

          const user_info = await user
            .findById(resident_info.creator)
            .select('_id notifications_enabled muted_push_devices')
            .lean();
          if (!user_info?._id) {
            console.log(
              `[camera-cron] SKIP ${camera.stream_name || camera._id}: creator ${resident_info.creator} not found`,
            );
            continue;
          }

          const camera_name = camera.stream_name || camera.room || 'Camera';

          // Update alert_state BEFORE dispatching so a crash doesn't re-fire
          // within the same 30-min window.
          await alert_state.updateOne(
            { key: state_key },
            { $set: { last_alert_time: new Date(), last_alert_level: 'warning' } },
          );

          console.log(
            `[camera-cron] CAMERA_OFFLINE: dispatching push for ${camera_name} (${camera._id}) — last_seen=${last_seen ? new Date(last_seen).toISOString() : 'NEVER'}, age=${age_ms != null ? Math.round(age_ms / 1000) + 's' : 'N/A'}`,
          );

          const result = await dispatch_notification({
            backend_event: 'CAMERA_OFFLINE',
            user_id: user_info._id,
            template_vars: {
              cameraName: camera_name,
              deviceId: camera._id ? camera._id.toString() : undefined,
            },
            data: {
              device_id: camera._id ? camera._id.toString() : null,
              camera_name,
              last_seen: last_seen ? new Date(last_seen).toISOString() : null,
            },
          });

          console.log(`[camera-cron] CAMERA_OFFLINE dispatch result: ${JSON.stringify(result)}`);

          // Emit socket event for real-time UI update.
          socket_service.send_to_user(String(user_info._id), 'camera_status', {
            device_id: camera._id ? camera._id.toString() : null,
            status: 'offline',
            camera_name,
            last_seen: last_seen ? new Date(last_seen).toISOString() : null,
          });

          console.log(
            `[camera-cron] CAMERA_OFFLINE notification: ${camera_name} (${camera._id}) — last seen ${last_seen ? new Date(last_seen).toISOString() : 'never'}`,
          );
        } catch (camera_error) {
          console.error('[camera-cron] camera error:', camera_error.message);
        }
      }
    } catch (error) {
      console.error('[camera-cron] checker crashed:', error.message);
    } finally {
      is_camera_checker_running = false;
    }
  });
};

export default {
  create_emfit_log,
  create_zigbee_log,
  get_bathroom_data,
  get_switch_data,
  get_switch_click_count_this_month,
  find_recent_zigbee_log,
  start_bathroom_alert_checker,
  start_emfit_alert_checker,
  start_contact_alert_checker,
  start_room_alert_checker,
  start_device_offline_checker,
  start_camera_health_checker,
  get_contact_data,
  get_room_state,
};
