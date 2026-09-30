/**
 * seed_ai_dev_data.js
 *
 * MongoDB seed script for the ai.dev@awesomliving.com account.
 * Creates 3 residents with 3 months of sample data so that another
 * developer can implement the 8 Abhi AI features.
 *
 * Collections seeded:
 *   users, homes, residents, devices,
 *   sleep_sessions, bp_readings,
 *   room_occupancy_states, room_occupancy_settings,
 *   alert_logs (unified alerts),
 *   monthly_summaries, dashboard_section_views,
 *   unknownroutelogs (raw GLK health data), zigbeeDevices
 *
 * Usage:
 *   node seed_ai_dev_data.js            # seed
 *   node seed_ai_dev_data.js --drop     # drop seeded data first, then seed
 *   node seed_ai_dev_data.js --cleanup  # only remove seeded data
 *
 * Requires: mongoose (npm install mongoose)
 *
 * IMPORTANT: All ObjectIds are deterministic (derived from names) so
 * the script is idempotent — running it twice will upsert, not duplicate.
 */

import mongoose from 'mongoose';

// ═══════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/awesomliving';
const SEED_TAG = 'ai_dev_seed'; // marker so we can clean up

// Date range: 3 months ending yesterday
const NOW = new Date();
const TODAY = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate());
const THREE_MONTHS_AGO = new Date(TODAY);
THREE_MONTHS_AGO.setMonth(THREE_MONTHS_AGO.getMonth() - 3);

// IST offset (UTC+5:30)
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

// ═══════════════════════════════════════════════════════════════════════
// DETERMINISTIC OBJECT IDS
// ═══════════════════════════════════════════════════════════════════════
const oid = (hex_suffix) => new mongoose.Types.ObjectId(hex_suffix.padStart(24, '0'));

const IDS = {
  user: oid('a1de0000000000000001'),
  home: oid('a1de0000000000000010'),
  residents: [
    oid('a1de0000000000000101'), // Amma (mother, 72)
    oid('a1de0000000000000102'), // Nani (grandmother, 78)
    oid('a1de0000000000000103'), // Dadu (grandfather, 81)
  ],
  // Per-resident devices: [glk, motion_room, motion_threshold, door_contact, bp_monitor]
  devices: {
    r0: {
      glk:              oid('a1de000000000000d010'),
      room_motion:      oid('a1de000000000000d011'),
      threshold_motion: oid('a1de000000000000d012'),
      door_contact:     oid('a1de000000000000d013'),
    },
    r1: {
      glk:              oid('a1de000000000000d020'),
      room_motion:      oid('a1de000000000000d021'),
      threshold_motion: oid('a1de000000000000d022'),
      door_contact:     oid('a1de000000000000d023'),
    },
    r2: {
      glk:              oid('a1de000000000000d030'),
      room_motion:      oid('a1de000000000000d031'),
      threshold_motion: oid('a1de000000000000d032'),
      door_contact:     oid('a1de000000000000d033'),
    },
  },
  bp_monitor: oid('a1de000000000000d099'), // shared BP monitor (home-level)
};

// ═══════════════════════════════════════════════════════════════════════
// RESIDENT PROFILES — drives data generation patterns
// ═══════════════════════════════════════════════════════════════════════
const RESIDENT_PROFILES = [
  {
    name: 'Amma',
    age: 72,
    gender: 'female',
    idx: 0,
    // Sleep: regular, 10:30 PM – 5:30 AM, good quality
    sleep: { bed_hour: 22, bed_min: 30, wake_hour: 5, wake_min: 30, quality: 'good' },
    // BP: mostly normal, occasional high systolic
    bp: { sys_mean: 128, sys_sd: 8, dia_mean: 78, dia_sd: 5, pulse_mean: 72, readings_per_day: 1.5 },
    // Room: moderate bathroom usage, 4-5x/day, 8-20 min
    room: { visits_per_day: 4.5, duration_mean_min: 12, duration_sd_min: 4 },
    // Alerts: low frequency
    alert_profile: { daily_rate: 0.15, false_positive_pct: 0.6 },
  },
  {
    name: 'Nani',
    age: 78,
    gender: 'female',
    idx: 1,
    // Sleep: later bedtime, more fragmented, lighter
    sleep: { bed_hour: 23, bed_min: 0, wake_hour: 6, wake_min: 0, quality: 'fair' },
    bp: { sys_mean: 138, sys_sd: 12, dia_mean: 82, dia_sd: 7, pulse_mean: 76, readings_per_day: 1 },
    room: { visits_per_day: 6, duration_mean_min: 15, duration_sd_min: 6 },
    alert_profile: { daily_rate: 0.3, false_positive_pct: 0.45 },
  },
  {
    name: 'Dadu',
    age: 81,
    gender: 'male',
    idx: 2,
    // Sleep: early bedtime, wakes early, more movement
    sleep: { bed_hour: 21, bed_min: 30, wake_hour: 4, wake_min: 45, quality: 'poor' },
    bp: { sys_mean: 145, sys_sd: 15, dia_mean: 85, dia_sd: 8, pulse_mean: 68, readings_per_day: 2 },
    room: { visits_per_day: 7, duration_mean_min: 18, duration_sd_min: 8 },
    alert_profile: { daily_rate: 0.5, false_positive_pct: 0.35 },
  },
];

// ═══════════════════════════════════════════════════════════════════════
// HELPER UTILITIES
// ═══════════════════════════════════════════════════════════════════════

/** Simple seeded PRNG (mulberry32) for reproducible data. */
let _seed = 42;
const seed_random = () => {
  let t = (_seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const rand_int = (min, max) => Math.floor(seed_random() * (max - min + 1)) + min;
const rand_float = (min, max) => seed_random() * (max - min) + min;
const rand_gaussian = (mean, sd) => {
  // Box-Muller transform
  const u1 = seed_random() || 0.0001;
  const u2 = seed_random();
  return mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
};
const rand_pick = (arr) => arr[Math.floor(seed_random() * arr.length)];
const clamp = (val, min, max) => Math.max(min, Math.min(max, val));

/** Compute platform_date per spec 2.1.1: start < 9 AM → same day, else next day. */
const compute_platform_date = (start_date) => {
  const ist = new Date(start_date.getTime() + IST_OFFSET_MS);
  const hour = ist.getUTCHours();
  if (hour < 9) {
    return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}-${String(ist.getUTCDate()).padStart(2, '0')}`;
  }
  const next = new Date(ist.getTime() + 24 * 60 * 60 * 1000);
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
};

/** Format date as YYYY-MM-DD in IST. */
const format_date_ist = (d) => {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}-${String(ist.getUTCDate()).padStart(2, '0')}`;
};

/** Iterate each day in [start, end). */
function* each_day(start, end) {
  const d = new Date(start);
  while (d < end) {
    yield new Date(d);
    d.setDate(d.getDate() + 1);
  }
}

/** Get month key "YYYY-MM" from a date. */
const month_key = (d) => {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}`;
};

// ═══════════════════════════════════════════════════════════════════════
// DATA GENERATORS
// ═══════════════════════════════════════════════════════════════════════

// ── 1. SLEEP SESSIONS ────────────────────────────────────────────────
function generate_sleep_sessions(profile, resident_id) {
  const sessions = [];
  const { bed_hour, bed_min, wake_hour, wake_min, quality } = profile.sleep;

  for (const day of each_day(THREE_MONTHS_AGO, TODAY)) {
    // ~5% chance of skipped night (no sleep data)
    if (seed_random() < 0.05) continue;

    // Vary bedtime ±30 min
    const bed_offset_min = rand_int(-30, 30);
    const start = new Date(day);
    start.setUTCHours(bed_hour - 5, bed_min + bed_offset_min - 30, rand_int(0, 59));
    // IST to UTC: subtract 5:30
    start.setTime(start.getTime() - IST_OFFSET_MS);

    // Vary wake time ±20 min
    const wake_offset_min = rand_int(-20, 20);
    const end = new Date(day);
    if (wake_hour < bed_hour) {
      // Next day wake
      end.setDate(end.getDate() + 1);
    }
    end.setUTCHours(wake_hour - 5, wake_min + wake_offset_min - 30, rand_int(0, 59));
    end.setTime(end.getTime() - IST_OFFSET_MS);

    const duration_ms = end.getTime() - start.getTime();
    if (duration_ms <= 0) continue;
    const duration_min = Math.round(duration_ms / 60000);

    // Sleep stages (minutes)
    const quality_factor = quality === 'good' ? 1.0 : quality === 'fair' ? 0.8 : 0.6;
    const deep_pct = clamp(rand_gaussian(0.18 * quality_factor, 0.04), 0.05, 0.30);
    const rem_pct = clamp(rand_gaussian(0.22 * quality_factor, 0.05), 0.08, 0.30);
    const awake_pct = clamp(rand_gaussian(0.08 / quality_factor, 0.03), 0.02, 0.20);
    const light_pct = 1 - deep_pct - rem_pct - awake_pct;

    const stages = {
      deep: Math.round(duration_min * deep_pct),
      rem: Math.round(duration_min * rem_pct),
      awake: Math.round(duration_min * awake_pct),
      light: Math.round(duration_min * light_pct),
    };

    // Vitals
    const avg_heart_rate = Math.round(clamp(rand_gaussian(62, 6), 48, 90));
    const avg_respiration = Math.round(clamp(rand_gaussian(15, 2), 10, 24));
    const movement_event_count = rand_int(
      quality === 'poor' ? 15 : 5,
      quality === 'poor' ? 40 : 20,
    );
    const snoring_detected = seed_random() < (quality === 'poor' ? 0.4 : 0.15);
    const toss_turn_count = rand_int(
      quality === 'poor' ? 8 : 2,
      quality === 'poor' ? 25 : 12,
    );

    sessions.push({
      resident: resident_id,
      start_time: start,
      end_time: end,
      platform_date: compute_platform_date(start),
      status: 'complete',
      duration_minutes: duration_min,
      stages,
      avg_heart_rate,
      avg_respiration,
      movement_event_count,
      snoring_detected,
      toss_turn_count,
      seed_tag: SEED_TAG,
      createdAt: end,
      updatedAt: end,
    });
  }
  return sessions;
}

// ── 2. BP READINGS ───────────────────────────────────────────────────
function generate_bp_readings(profile, resident_id) {
  const readings = [];
  const { sys_mean, sys_sd, dia_mean, dia_sd, pulse_mean, readings_per_day } = profile.bp;

  for (const day of each_day(THREE_MONTHS_AGO, TODAY)) {
    // Number of readings this day (Poisson-ish)
    let count = 0;
    let acc = 0;
    while (acc < 1) {
      acc += -Math.log(1 - seed_random()) / readings_per_day;
      if (acc < 1) count++;
    }
    if (count === 0 && seed_random() < 0.7) count = 1; // most days have at least one

    for (let i = 0; i < count; i++) {
      // Morning or evening reading
      const is_morning = seed_random() < 0.6;
      const hour = is_morning ? rand_int(6, 9) : rand_int(18, 21);
      const taken = new Date(day);
      taken.setUTCHours(hour - 5, rand_int(0, 59) - 30, rand_int(0, 59));
      taken.setTime(taken.getTime() - IST_OFFSET_MS);

      const systolic = Math.round(clamp(rand_gaussian(sys_mean, sys_sd), 90, 200));
      const diastolic = Math.round(clamp(rand_gaussian(dia_mean, dia_sd), 55, 120));
      const pulse = Math.round(clamp(rand_gaussian(pulse_mean, 5), 50, 110));

      const received = new Date(taken.getTime() + rand_int(500, 3000));
      const mapped = new Date(received.getTime() + rand_int(5000, 60000));

      readings.push({
        home: IDS.home,
        resident: resident_id,
        systolic,
        diastolic,
        pulse,
        taken_at: taken,
        received_at: received,
        mapped_at: mapped,
        mapped_by: IDS.user,
        seed_tag: SEED_TAG,
        createdAt: received,
        updatedAt: mapped,
      });
    }
  }
  return readings;
}

// ── 3. ROOM OCCUPANCY EVENTS & STATE ─────────────────────────────────
function generate_room_occupancy_data(profile, resident_id, device_ids) {
  const events = [];
  const occupancy_group = `washroom_r${profile.idx}`;

  for (const day of each_day(THREE_MONTHS_AGO, TODAY)) {
    const n_visits = Math.round(clamp(
      rand_gaussian(profile.room.visits_per_day, 1.5),
      1,
      profile.room.visits_per_day * 2,
    ));

    // Spread visits across waking hours (6 AM – 11 PM IST)
    const visit_hours = [];
    for (let v = 0; v < n_visits; v++) {
      visit_hours.push(rand_float(6, 23));
    }
    visit_hours.sort((a, b) => a - b);

    for (const hour_f of visit_hours) {
      const hour = Math.floor(hour_f);
      const minute = Math.floor((hour_f % 1) * 60);
      const duration_min = Math.round(clamp(
        rand_gaussian(profile.room.duration_mean_min, profile.room.duration_sd_min),
        3,
        60,
      ));

      const entry_time = new Date(day);
      entry_time.setUTCHours(hour - 5, minute - 30, rand_int(0, 59));
      entry_time.setTime(entry_time.getTime() - IST_OFFSET_MS);

      const exit_time = new Date(entry_time.getTime() + duration_min * 60000);

      // Entry sequence: threshold_motion → door_open → door_close → room_motion
      events.push({
        resident: resident_id,
        occupancy_group,
        event_type: 'threshold_motion',
        timestamp: new Date(entry_time.getTime() - rand_int(2000, 8000)),
        raw_source: 'zigbee',
        seed_tag: SEED_TAG,
      });
      events.push({
        resident: resident_id,
        occupancy_group,
        event_type: 'door_open',
        timestamp: new Date(entry_time.getTime()),
        raw_source: 'zigbee',
        seed_tag: SEED_TAG,
      });
      events.push({
        resident: resident_id,
        occupancy_group,
        event_type: 'door_close',
        timestamp: new Date(entry_time.getTime() + rand_int(2000, 5000)),
        raw_source: 'zigbee',
        seed_tag: SEED_TAG,
      });
      events.push({
        resident: resident_id,
        occupancy_group,
        event_type: 'room_motion',
        timestamp: new Date(entry_time.getTime() + rand_int(5000, 15000)),
        raw_source: 'zigbee',
        seed_tag: SEED_TAG,
      });

      // Periodic room_motion during occupancy (every 2-5 min)
      let motion_time = entry_time.getTime() + 120000;
      while (motion_time < exit_time.getTime() - 30000) {
        events.push({
          resident: resident_id,
          occupancy_group,
          event_type: 'room_motion',
          timestamp: new Date(motion_time),
          raw_source: 'zigbee',
          seed_tag: SEED_TAG,
        });
        motion_time += rand_int(120000, 300000);
      }

      // Exit sequence: door_open → door_close → threshold_motion
      events.push({
        resident: resident_id,
        occupancy_group,
        event_type: 'door_open',
        timestamp: new Date(exit_time.getTime()),
        raw_source: 'zigbee',
        seed_tag: SEED_TAG,
      });
      events.push({
        resident: resident_id,
        occupancy_group,
        event_type: 'door_close',
        timestamp: new Date(exit_time.getTime() + rand_int(2000, 5000)),
        raw_source: 'zigbee',
        seed_tag: SEED_TAG,
      });
      events.push({
        resident: resident_id,
        occupancy_group,
        event_type: 'threshold_motion',
        timestamp: new Date(exit_time.getTime() + rand_int(3000, 10000)),
        raw_source: 'zigbee',
        seed_tag: SEED_TAG,
      });
    }
  }

  // Current occupancy state (set to vacant)
  const state = {
    resident: resident_id,
    occupancy_group,
    room_label: 'Washroom',
    state: 'vacant',
    occupied_since: null,
    entry_step: 0,
    entry_started_at: null,
    entry_master_confirmed: false,
    entry_curtain_cleared: false,
    exit_step: 0,
    exit_started_at: null,
    exit_silence_start_at: null,
    exit_curtain_triggered: false,
    master_is_active: false,
    curtain_is_active: false,
    door_is_open: false,
    last_master_false_at: null,
    last_master_event_at: null,
    last_door_event_at: null,
    last_curtain_event_at: null,
    stillness_alert_sent: false,
    long_stay_level_reached: 0,
    safety_ceiling_alert_sent: false,
    threshold_device: device_ids.threshold_motion,
    room_motion_device: device_ids.room_motion,
    door_device: device_ids.door_contact,
    seed_tag: SEED_TAG,
  };

  return { events, state };
}

// ── 4. ALERTS (unified alert_log) ────────────────────────────────────
const ALERT_TYPES = [
  { type: 'long_stay', title: 'Long stay alert', device_type: 'zigbee', levels: ['warning', 'critical', 'emergency'] },
  { type: 'no_motion', title: 'No movement detected', device_type: 'zigbee', levels: ['warning', 'emergency'] },
  { type: 'door_open', title: 'Door left open', device_type: 'zigbee', levels: ['warning'] },
  { type: 'bp_out_of_range', title: 'Blood pressure out of range', device_type: 'BpMonitor', levels: ['warning', 'critical'] },
  { type: 'fall_detected', title: 'Possible fall detected', device_type: 'Eltum', levels: ['emergency'] },
  { type: 'emergency_button', title: 'Emergency button pressed', device_type: 'zigbee', levels: ['emergency'] },
];

function generate_alerts(profile, resident_id, device_ids) {
  const alerts = [];
  const { daily_rate, false_positive_pct } = profile.alert_profile;

  for (const day of each_day(THREE_MONTHS_AGO, TODAY)) {
    // Poisson draw for number of alerts this day
    if (seed_random() > daily_rate) continue;

    const n = seed_random() < 0.1 ? 2 : 1; // rare double-alert day
    for (let i = 0; i < n; i++) {
      const alert_def = rand_pick(ALERT_TYPES);
      const hour = rand_int(6, 23);
      const triggered = new Date(day);
      triggered.setUTCHours(hour - 5, rand_int(0, 59) - 30, rand_int(0, 59));
      triggered.setTime(triggered.getTime() - IST_OFFSET_MS);

      const is_resolved = seed_random() < 0.85;
      const is_false_positive = is_resolved && seed_random() < false_positive_pct;
      const resolution_reason = !is_resolved
        ? null
        : is_false_positive
          ? 'false_positive'
          : 'confirmed_concern';

      const resolved_at = is_resolved
        ? new Date(triggered.getTime() + rand_int(60000, 3600000))
        : null;

      const level = rand_pick(alert_def.levels);
      const device_key = alert_def.device_type === 'zigbee'
        ? rand_pick(['room_motion', 'threshold_motion', 'door_contact'])
        : null;

      alerts.push({
        title: alert_def.title,
        description: `${profile.name} — ${alert_def.type.replace(/_/g, ' ')} alert`,
        resident: resident_id,
        home: IDS.home,
        device: device_key ? device_ids[device_key] : null,
        device_type: alert_def.device_type,
        alert_type: alert_def.type,
        alert_level: level,
        is_resolved,
        resolved_at,
        resolution_reason,
        meta: {
          sensor_type: alert_def.device_type === 'zigbee' ? 'occupancy_group' : alert_def.device_type,
          occupancy_group: `washroom_r${profile.idx}`,
          room: 'Washroom',
          alert_type: alert_def.type,
        },
        seed_tag: SEED_TAG,
        createdAt: triggered,
        updatedAt: resolved_at || triggered,
      });
    }
  }
  return alerts;
}

// ── 5. MONTHLY SUMMARY ──────────────────────────────────────────────
function generate_monthly_summaries(sleep_sessions, bp_readings, alerts, resident_id) {
  const months = {};

  // Aggregate sleep
  for (const s of sleep_sessions) {
    const mk = s.platform_date.substring(0, 7); // "YYYY-MM"
    if (!months[mk]) months[mk] = { sleep: [], bp: [], alerts: [] };
    months[mk].sleep.push(s);
  }

  // Aggregate BP
  for (const bp of bp_readings) {
    const mk = month_key(bp.taken_at);
    if (!months[mk]) months[mk] = { sleep: [], bp: [], alerts: [] };
    months[mk].bp.push(bp);
  }

  // Aggregate alerts
  for (const a of alerts) {
    const mk = month_key(a.createdAt);
    if (!months[mk]) months[mk] = { sleep: [], bp: [], alerts: [] };
    months[mk].alerts.push(a);
  }

  return Object.entries(months).map(([m, data]) => {
    const avg_sleep = data.sleep.length > 0
      ? Math.round(data.sleep.reduce((s, x) => s + x.duration_minutes, 0) / data.sleep.length)
      : null;
    const avg_hr = data.sleep.length > 0
      ? Math.round(data.sleep.reduce((s, x) => s + x.avg_heart_rate, 0) / data.sleep.length)
      : null;
    const avg_sys = data.bp.length > 0
      ? Math.round(data.bp.reduce((s, x) => s + x.systolic, 0) / data.bp.length)
      : null;
    const avg_dia = data.bp.length > 0
      ? Math.round(data.bp.reduce((s, x) => s + x.diastolic, 0) / data.bp.length)
      : null;
    const avg_movement = data.sleep.length > 0
      ? Math.round(data.sleep.reduce((s, x) => s + x.movement_event_count, 0) / data.sleep.length)
      : null;
    const snoring_nights = data.sleep.filter((s) => s.snoring_detected).length;
    const avg_toss = data.sleep.length > 0
      ? Math.round(data.sleep.reduce((s, x) => s + x.toss_turn_count, 0) / data.sleep.length)
      : null;

    // Alert counts by type
    const alert_counts = {};
    for (const a of data.alerts) {
      alert_counts[a.alert_type] = (alert_counts[a.alert_type] || 0) + 1;
    }

    return {
      resident: resident_id,
      month: m,
      avg_sleep_minutes: avg_sleep,
      avg_resting_hr: avg_hr,
      avg_bp_systolic: avg_sys,
      avg_bp_diastolic: avg_dia,
      bp_reading_count: data.bp.length,
      avg_movement_events: avg_movement,
      snoring_nights_count: snoring_nights,
      avg_toss_turn_count: avg_toss,
      alert_counts_by_type: alert_counts,
      total_alerts: data.alerts.length,
      seed_tag: SEED_TAG,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  });
}

// ── 6. DASHBOARD SECTION VIEWS ──────────────────────────────────────
const DASHBOARD_SECTIONS = [
  'daily_narrative', 'sleep_card', 'vitals_card', 'bp_card',
  'room_status', 'camera_feed', 'alerts_list', 'activity_timeline',
];

function generate_dashboard_views() {
  const views = [];
  for (const day of each_day(THREE_MONTHS_AGO, TODAY)) {
    // 1-3 views per day
    const n = rand_int(1, 3);
    for (let i = 0; i < n; i++) {
      const section = rand_pick(DASHBOARD_SECTIONS);
      const hour = rand_int(7, 23);
      const viewed = new Date(day);
      viewed.setUTCHours(hour - 5, rand_int(0, 59) - 30, rand_int(0, 59));
      viewed.setTime(viewed.getTime() - IST_OFFSET_MS);

      views.push({
        account_holder: IDS.user,
        home: IDS.home,
        section,
        viewed_at: viewed,
        seed_tag: SEED_TAG,
        createdAt: viewed,
        updatedAt: viewed,
      });
    }
  }
  return views;
}

// ── 7. RAW GLK HEALTH LOGS (unknownroutelogs) ──────────────────────
// These mirror the actual GLK data that currently lands in unknown_routelogs.
// The dashboard_service reads from here to build sleep/vitals views.
function generate_glk_raw_logs(profile, resident_id, sr_num) {
  const logs = [];

  for (const day of each_day(THREE_MONTHS_AGO, TODAY)) {
    if (seed_random() < 0.05) continue; // skip ~5% days

    const { bed_hour, bed_min, wake_hour, wake_min, quality } = profile.sleep;

    // Generate minute-by-minute GLK readings for the sleep window
    const start = new Date(day);
    start.setUTCHours(bed_hour - 5, bed_min - 30 + rand_int(-15, 15), 0);
    start.setTime(start.getTime() - IST_OFFSET_MS);

    const end = new Date(day);
    if (wake_hour < bed_hour) end.setDate(end.getDate() + 1);
    end.setUTCHours(wake_hour - 5, wake_min - 30 + rand_int(-10, 10), 0);
    end.setTime(end.getTime() - IST_OFFSET_MS);

    // Emit one log every 5 minutes (to keep data size reasonable)
    let t = start.getTime();
    const sleep_states = ['sleeping', 'sleeping', 'sleeping', 'awake']; // weighted
    while (t < end.getTime()) {
      const state = quality === 'poor' && seed_random() < 0.15
        ? 'awake'
        : rand_pick(sleep_states);

      const activity = state === 'awake'
        ? rand_int(30, 120)
        : rand_int(0, 20);

      const heart_rate = Math.round(clamp(rand_gaussian(state === 'awake' ? 72 : 60, 5), 45, 100));
      const respiration = Math.round(clamp(rand_gaussian(state === 'awake' ? 17 : 14, 2), 8, 28));
      const in_bed = state === 'awake' && seed_random() < 0.1 ? 0 : 1;
      const snoring = seed_random() < (quality === 'poor' ? 0.12 : 0.04) ? 1 : 0;
      const toss_turn = seed_random() < (quality === 'poor' ? 0.1 : 0.03) ? 1 : 0;

      const timestamp_sec = Math.floor(t / 1000);

      logs.push({
        method: 'POST',
        path: '/api/health',
        body: {
          serialnumber: sr_num,
          timestamp: timestamp_sec,
          in_bed,
          activity,
          heart_rate,
          respiration,
          sleep_stage: state,
          snoring,
          tossnturn: toss_turn,
          intention_to_leave_bed: 0,
        },
        params: {},
        query: {},
        headers: { 'content-type': 'application/json' },
        createdAt: new Date(t + rand_int(0, 60000)),
        updatedAt: new Date(t + rand_int(0, 60000)),
        seed_tag: SEED_TAG,
      });

      t += 5 * 60 * 1000; // 5-minute intervals
    }
  }
  return logs;
}

// ── 8. ZIGBEE DEVICE LOGS ────────────────────────────────────────────
function generate_zigbee_logs(profile, device_ids) {
  const logs = [];
  const occupancy_group = `washroom_r${profile.idx}`;

  for (const day of each_day(THREE_MONTHS_AGO, TODAY)) {
    const n_events = rand_int(8, 30);
    for (let i = 0; i < n_events; i++) {
      const hour = rand_int(5, 23);
      const ts = new Date(day);
      ts.setUTCHours(hour - 5, rand_int(0, 59) - 30, rand_int(0, 59));
      ts.setTime(ts.getTime() - IST_OFFSET_MS);

      const sensor_type = rand_pick(['motion', 'motion', 'contact', 'motion']);
      const device_name = sensor_type === 'contact'
        ? `door_sensor_${occupancy_group}`
        : `motion_sensor_${occupancy_group}_${seed_random() < 0.5 ? 'room' : 'threshold'}`;

      logs.push({
        device_name,
        type: sensor_type === 'contact' ? 'contact' : 'occupancy',
        action: null,
        occupancy: sensor_type !== 'contact' ? (seed_random() < 0.5) : null,
        contact: sensor_type === 'contact' ? (seed_random() < 0.5) : null,
        data: {
          occupancy_group,
          sensor_role: sensor_type === 'contact'
            ? 'occupancy_door'
            : seed_random() < 0.5 ? 'room_motion' : 'threshold_motion',
        },
        time_bucket: format_date_ist(ts),
        seed_tag: SEED_TAG,
        createdAt: ts,
        updatedAt: ts,
      });
    }
  }
  return logs;
}

// ═══════════════════════════════════════════════════════════════════════
// MONGOOSE SCHEMAS (inline, minimal — just enough for insertMany)
// ═══════════════════════════════════════════════════════════════════════
const { Schema } = mongoose;
const OId = Schema.Types.ObjectId;
const Mixed = Schema.Types.Mixed;

const user_schema = new Schema({
  email: String,
  name: String,
  phone: String,
  password: String,
  role: { type: String, default: 'user' },
  notifications_enabled: { type: Boolean, default: true },
  quiet_hours_enabled: { type: Boolean, default: false },
  quiet_hours_start: { type: String, default: '22:00' },
  quiet_hours_end: { type: String, default: '06:00' },
  muted_alert_devices: [String],
  muted_push_devices: [String],
  ai_enabled: { type: Boolean, default: true },
  seed_tag: String,
}, { timestamps: true, collection: 'users' });

const home_schema = new Schema({
  name: String,
  address: String,
  city: String,
  timezone: { type: String, default: 'Asia/Kolkata' },
  user_id: { type: OId, ref: 'users' },
  ai_enabled: { type: Boolean, default: true },
  seed_tag: String,
}, { timestamps: true, collection: 'homes' });

const resident_schema = new Schema({
  name: String,
  age: Number,
  gender: String,
  home: { type: OId, ref: 'homes' },
  creator: { type: OId, ref: 'users' },
  selected: { type: Boolean, default: false },
  bp_normal_systolic_min: { type: Number, default: 100 },
  bp_normal_systolic_max: { type: Number, default: 140 },
  bp_normal_diastolic_min: { type: Number, default: 60 },
  bp_normal_diastolic_max: { type: Number, default: 90 },
  seed_tag: String,
}, { timestamps: true, collection: 'residents' });

const device_schema = new Schema({
  type: { type: String, enum: ['Eltum', 'Emfit', 'Zigbee', 'CpPlus', 'BpMonitor'] },
  name: String,
  status: { type: String, default: 'active' },
  resident: { type: OId, ref: 'residents' },
  home: { type: OId, ref: 'homes' },
  sr_num: String,
  // Zigbee-specific
  id: String,
  ieee: String,
  sensor_type: String,
  room: String,
  occupancy_group: String,
  sensor_role: { type: String, enum: [null, 'threshold_motion', 'room_motion', 'occupancy_door'] },
  paired_motion_ieee: String,
  paired_window_ieee: String,
  seed_tag: String,
}, { timestamps: true, collection: 'devices', discriminatorKey: 'type' });

const sleep_session_schema = new Schema({
  resident: { type: OId, ref: 'residents', required: true },
  start_time: Date,
  end_time: Date,
  platform_date: String,
  status: { type: String, enum: ['in_progress', 'complete', 'capped'], default: 'complete' },
  duration_minutes: Number,
  stages: {
    light: Number,
    deep: Number,
    rem: Number,
    awake: Number,
  },
  avg_heart_rate: Number,
  avg_respiration: Number,
  movement_event_count: Number,
  snoring_detected: Boolean,
  toss_turn_count: Number,
  seed_tag: String,
}, { timestamps: true, collection: 'sleep_sessions' });

const bp_reading_schema = new Schema({
  home: { type: OId, ref: 'homes' },
  resident: { type: OId, ref: 'residents' },
  systolic: Number,
  diastolic: Number,
  pulse: Number,
  taken_at: Date,
  received_at: Date,
  mapped_at: Date,
  mapped_by: { type: OId, ref: 'users' },
  seed_tag: String,
}, { timestamps: true, collection: 'bp_readings' });

const room_occupancy_event_schema = new Schema({
  resident: { type: OId, ref: 'residents' },
  occupancy_group: String,
  event_type: { type: String, enum: ['door_open', 'door_close', 'threshold_motion', 'room_motion'] },
  timestamp: Date,
  raw_source: String,
  seed_tag: String,
}, { timestamps: true, collection: 'room_occupancy_events' });

const room_occupancy_state_schema = new Schema({
  resident: { type: OId, ref: 'residents', required: true },
  occupancy_group: { type: String, required: true },
  room_label: String,
  state: { type: String, enum: ['vacant', 'entry_pending', 'occupied', 'exit_pending'], default: 'vacant' },
  occupied_since: Date,
  entry_step: { type: Number, default: 0 },
  entry_started_at: Date,
  entry_master_confirmed: { type: Boolean, default: false },
  entry_curtain_cleared: { type: Boolean, default: false },
  exit_step: { type: Number, default: 0 },
  exit_started_at: Date,
  exit_silence_start_at: Date,
  exit_curtain_triggered: { type: Boolean, default: false },
  master_is_active: { type: Boolean, default: false },
  curtain_is_active: { type: Boolean, default: false },
  door_is_open: { type: Boolean, default: false },
  last_master_false_at: Date,
  last_master_event_at: Date,
  last_door_event_at: Date,
  last_curtain_event_at: Date,
  stillness_alert_sent: { type: Boolean, default: false },
  stillness_alert_sent_at: Date,
  stillness_alert_log_id: { type: OId, ref: 'alert_log' },
  long_stay_level_reached: { type: Number, default: 0 },
  long_stay_level_1_time: Date,
  long_stay_level_1_log_id: OId,
  long_stay_level_2_time: Date,
  long_stay_level_2_log_id: OId,
  long_stay_level_3_time: Date,
  long_stay_level_3_log_id: OId,
  long_stay_last_emergency_repeat_at: Date,
  safety_ceiling_alert_sent: { type: Boolean, default: false },
  safety_ceiling_alert_time: Date,
  safety_ceiling_alert_log_id: OId,
  threshold_device: { type: OId, ref: 'devices' },
  room_motion_device: { type: OId, ref: 'devices' },
  door_device: { type: OId, ref: 'devices' },
  seed_tag: String,
}, { timestamps: true, collection: 'room_occupancy_states' });

const room_occupancy_settings_schema = new Schema({
  resident: { type: OId, ref: 'residents', required: true },
  occupancy_group: { type: String, required: true },
  entry_confirmation_window_sec: { type: Number, default: 420 },
  exit_signal_window_sec: { type: Number, default: 420 },
  exit_confirmation_quiet_sec: { type: Number, default: 60 },
  long_stay_level_1_min: { type: Number, default: 30 },
  no_motion_level_1_min: { type: Number, default: 15 },
  no_motion_level_2_min: { type: Number, default: 30 },
  no_motion_level_3_min: { type: Number, default: 60 },
  safety_ceiling_hours: { type: Number, default: 4 },
  night_mode_enabled: { type: Boolean, default: false },
  night_long_stay_level_1_min: { type: Number, default: 60 },
  night_no_motion_level_1_min: { type: Number, default: 30 },
  night_from: { type: String, default: '22:00' },
  night_to: { type: String, default: '06:00' },
  test_mode: { type: Boolean, default: false },
  emergency_repeat_interval_min: { type: Number, default: 5 },
  is_active: { type: Boolean, default: true },
  seed_tag: String,
}, { timestamps: true, collection: 'room_occupancy_settings' });

const alert_log_schema = new Schema({
  title: String,
  description: String,
  resident: { type: OId, ref: 'residents' },
  home: { type: OId, ref: 'homes' },
  device: { type: OId, ref: 'devices' },
  device_type: String,
  alert_type: String,
  alert_level: { type: String, enum: ['info', 'warning', 'danger', 'critical', 'emergency'] },
  is_resolved: { type: Boolean, default: false },
  resolved_at: Date,
  resolution_reason: { type: String, enum: ['false_positive', 'confirmed_concern', null], default: null },
  meta: Mixed,
  seed_tag: String,
}, { timestamps: true, collection: 'alert_logs' });

const monthly_summary_schema = new Schema({
  resident: { type: OId, ref: 'residents' },
  month: String,
  avg_sleep_minutes: Number,
  avg_resting_hr: Number,
  avg_bp_systolic: Number,
  avg_bp_diastolic: Number,
  bp_reading_count: Number,
  avg_movement_events: Number,
  snoring_nights_count: Number,
  avg_toss_turn_count: Number,
  alert_counts_by_type: Mixed,
  total_alerts: Number,
  seed_tag: String,
}, { timestamps: true, collection: 'monthly_summaries' });

const dashboard_section_view_schema = new Schema({
  account_holder: { type: OId, ref: 'users' },
  home: { type: OId, ref: 'homes' },
  section: String,
  viewed_at: Date,
  seed_tag: String,
}, { timestamps: true, collection: 'dashboard_section_views' });

const unknown_route_log_schema = new Schema({
  method: String,
  path: String,
  body: Mixed,
  params: Mixed,
  query: Mixed,
  headers: Mixed,
  seed_tag: String,
}, { timestamps: true, collection: 'unknownroutelogs' });

const zigbee_log_schema = new Schema({
  device_name: String,
  type: String,
  action: Mixed,
  occupancy: Mixed,
  contact: Mixed,
  data: Mixed,
  time_bucket: String,
  seed_tag: String,
}, { timestamps: true, collection: 'zigbeeDevices' });

// ═══════════════════════════════════════════════════════════════════════
// REGISTER MODELS
// ═══════════════════════════════════════════════════════════════════════
const User = mongoose.model('seed_user', user_schema);
const Home = mongoose.model('seed_home', home_schema);
const Resident = mongoose.model('seed_resident', resident_schema);
const Device = mongoose.model('seed_device', device_schema);
const SleepSession = mongoose.model('seed_sleep_session', sleep_session_schema);
const BpReading = mongoose.model('seed_bp_reading', bp_reading_schema);
const RoomOccupancyEvent = mongoose.model('seed_room_occupancy_event', room_occupancy_event_schema);
const RoomOccupancyState = mongoose.model('seed_room_occupancy_state', room_occupancy_state_schema);
const RoomOccupancySettings = mongoose.model('seed_room_occupancy_settings', room_occupancy_settings_schema);
const AlertLog = mongoose.model('seed_alert_log', alert_log_schema);
const MonthlySummary = mongoose.model('seed_monthly_summary', monthly_summary_schema);
const DashboardSectionView = mongoose.model('seed_dashboard_section_view', dashboard_section_view_schema);
const UnknownRouteLog = mongoose.model('seed_unknown_route_log', unknown_route_log_schema);
const ZigbeeLog = mongoose.model('seed_zigbee_log', zigbee_log_schema);

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════
async function cleanup() {
  console.log('[cleanup] Removing all seeded data (seed_tag = ai_dev_seed)...');
  const collections = [
    User, Home, Resident, Device, SleepSession, BpReading,
    RoomOccupancyEvent, RoomOccupancyState, RoomOccupancySettings,
    AlertLog, MonthlySummary, DashboardSectionView,
    UnknownRouteLog, ZigbeeLog,
  ];
  for (const model of collections) {
    const result = await model.deleteMany({ seed_tag: SEED_TAG });
    console.log(`  ${model.collection.collectionName}: ${result.deletedCount} removed`);
  }
  console.log('[cleanup] Done.');
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN SEED FUNCTION
// ═══════════════════════════════════════════════════════════════════════
async function seed() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Awesom Living — AI Features Sample Data Seed');
  console.log('  Account:  ai.dev@awesomliving.com');
  console.log(`  Period:   ${format_date_ist(THREE_MONTHS_AGO)} → ${format_date_ist(TODAY)}`);
  console.log('  Residents: 3 (Amma 72F, Nani 78F, Dadu 81M)');
  console.log('═══════════════════════════════════════════════════════════');

  // ── 1. User ──
  console.log('\n[1/12] Creating user...');
  await User.findOneAndUpdate(
    { _id: IDS.user },
    {
      _id: IDS.user,
      email: 'ai.dev@awesomliving.com',
      name: 'AI Dev Account',
      phone: '+919876543210',
      password: '$2b$10$placeholder_hashed_password_for_seed_data',
      role: 'user',
      notifications_enabled: true,
      ai_enabled: true,
      seed_tag: SEED_TAG,
    },
    { upsert: true, new: true },
  );
  console.log('  ✓ User: ai.dev@awesomliving.com');

  // ── 2. Home ──
  console.log('[2/12] Creating home...');
  await Home.findOneAndUpdate(
    { _id: IDS.home },
    {
      _id: IDS.home,
      name: 'AI Dev Home',
      address: '42, Sector 18, Noida, UP',
      city: 'Noida',
      timezone: 'Asia/Kolkata',
      user_id: IDS.user,
      ai_enabled: true,
      seed_tag: SEED_TAG,
    },
    { upsert: true, new: true },
  );
  console.log('  ✓ Home: AI Dev Home');

  // ── 3. Residents ──
  console.log('[3/12] Creating residents...');
  for (let i = 0; i < RESIDENT_PROFILES.length; i++) {
    const p = RESIDENT_PROFILES[i];
    await Resident.findOneAndUpdate(
      { _id: IDS.residents[i] },
      {
        _id: IDS.residents[i],
        name: p.name,
        age: p.age,
        gender: p.gender,
        home: IDS.home,
        creator: IDS.user,
        selected: i === 0,
        bp_normal_systolic_min: 100,
        bp_normal_systolic_max: p.bp.sys_mean < 135 ? 140 : 150,
        bp_normal_diastolic_min: 60,
        bp_normal_diastolic_max: 90,
        seed_tag: SEED_TAG,
      },
      { upsert: true, new: true },
    );
    console.log(`  ✓ Resident: ${p.name} (${p.age}${p.gender[0].toUpperCase()})`);
  }

  // ── 4. Devices ──
  console.log('[4/12] Creating devices...');
  const sr_nums = ['GLK_AI_DEV_001', 'GLK_AI_DEV_002', 'GLK_AI_DEV_003'];
  const device_keys = ['r0', 'r1', 'r2'];

  for (let i = 0; i < 3; i++) {
    const dk = device_keys[i];
    const rid = IDS.residents[i];
    const devs = IDS.devices[dk];
    const occ_group = `washroom_r${i}`;

    // GLK (type Emfit in the current schema)
    await Device.findOneAndUpdate(
      { _id: devs.glk },
      {
        _id: devs.glk,
        type: 'Emfit',
        name: `GLK Vital Tracker - ${RESIDENT_PROFILES[i].name}`,
        status: 'active',
        resident: rid,
        home: IDS.home,
        sr_num: sr_nums[i],
        seed_tag: SEED_TAG,
      },
      { upsert: true, new: true },
    );

    // Room motion sensor (Zigbee)
    await Device.findOneAndUpdate(
      { _id: devs.room_motion },
      {
        _id: devs.room_motion,
        type: 'Zigbee',
        name: `Room Motion - ${occ_group}`,
        status: 'active',
        resident: rid,
        home: IDS.home,
        id: `motion_sensor_${occ_group}_room`,
        ieee: `0x00158d0000${String(i * 3 + 1).padStart(6, '0')}`,
        sensor_type: 'motion',
        room: 'Washroom',
        occupancy_group: occ_group,
        sensor_role: 'room_motion',
        seed_tag: SEED_TAG,
      },
      { upsert: true, new: true },
    );

    // Threshold motion sensor (Zigbee)
    await Device.findOneAndUpdate(
      { _id: devs.threshold_motion },
      {
        _id: devs.threshold_motion,
        type: 'Zigbee',
        name: `Threshold Motion - ${occ_group}`,
        status: 'active',
        resident: rid,
        home: IDS.home,
        id: `motion_sensor_${occ_group}_threshold`,
        ieee: `0x00158d0000${String(i * 3 + 2).padStart(6, '0')}`,
        sensor_type: 'motion',
        room: 'Washroom',
        occupancy_group: occ_group,
        sensor_role: 'threshold_motion',
        seed_tag: SEED_TAG,
      },
      { upsert: true, new: true },
    );

    // Door/contact sensor (Zigbee)
    await Device.findOneAndUpdate(
      { _id: devs.door_contact },
      {
        _id: devs.door_contact,
        type: 'Zigbee',
        name: `Door Sensor - ${occ_group}`,
        status: 'active',
        resident: rid,
        home: IDS.home,
        id: `door_sensor_${occ_group}`,
        ieee: `0x00158d0000${String(i * 3 + 3).padStart(6, '0')}`,
        sensor_type: 'contact',
        room: 'Washroom',
        occupancy_group: occ_group,
        sensor_role: 'occupancy_door',
        seed_tag: SEED_TAG,
      },
      { upsert: true, new: true },
    );
  }

  // Shared BP monitor
  await Device.findOneAndUpdate(
    { _id: IDS.bp_monitor },
    {
      _id: IDS.bp_monitor,
      type: 'BpMonitor',
      name: 'A&D BP Monitor (Shared)',
      status: 'active',
      resident: null,
      home: IDS.home,
      seed_tag: SEED_TAG,
    },
    { upsert: true, new: true },
  );
  console.log('  ✓ 13 devices created (3 GLK + 3×3 Zigbee + 1 BP monitor)');

  // ── 5-12: Per-resident data ──
  let total_sleep = 0, total_bp = 0, total_events = 0, total_alerts = 0;
  let total_summaries = 0, total_glk = 0, total_zigbee = 0;

  for (let i = 0; i < 3; i++) {
    const profile = RESIDENT_PROFILES[i];
    const rid = IDS.residents[i];
    const dk = device_keys[i];
    const devs = IDS.devices[dk];
    console.log(`\n── Resident ${i + 1}/3: ${profile.name} ──`);

    // Sleep sessions
    console.log(`[5/12] Generating sleep sessions...`);
    const sleep = generate_sleep_sessions(profile, rid);
    if (sleep.length > 0) {
      await SleepSession.deleteMany({ resident: rid, seed_tag: SEED_TAG });
      await SleepSession.insertMany(sleep, { ordered: false });
    }
    console.log(`  ✓ ${sleep.length} sleep sessions`);
    total_sleep += sleep.length;

    // BP readings
    console.log(`[6/12] Generating BP readings...`);
    const bp = generate_bp_readings(profile, rid);
    if (bp.length > 0) {
      await BpReading.deleteMany({ resident: rid, seed_tag: SEED_TAG });
      await BpReading.insertMany(bp, { ordered: false });
    }
    console.log(`  ✓ ${bp.length} BP readings`);
    total_bp += bp.length;

    // Room occupancy
    console.log(`[7/12] Generating room occupancy events...`);
    const occ = generate_room_occupancy_data(profile, rid, devs);
    if (occ.events.length > 0) {
      await RoomOccupancyEvent.deleteMany({ resident: rid, seed_tag: SEED_TAG });
      await RoomOccupancyEvent.insertMany(occ.events, { ordered: false });
    }
    await RoomOccupancyState.findOneAndUpdate(
      { resident: rid, occupancy_group: occ.state.occupancy_group },
      occ.state,
      { upsert: true, new: true },
    );
    console.log(`  ✓ ${occ.events.length} occupancy events + 1 state doc`);
    total_events += occ.events.length;

    // Room occupancy settings
    console.log(`[8/12] Creating room occupancy settings...`);
    await RoomOccupancySettings.findOneAndUpdate(
      { resident: rid, occupancy_group: `washroom_r${i}` },
      {
        resident: rid,
        occupancy_group: `washroom_r${i}`,
        entry_confirmation_window_sec: 420,
        exit_signal_window_sec: 420,
        exit_confirmation_quiet_sec: 60,
        long_stay_level_1_min: 30,
        no_motion_level_1_min: 15,
        no_motion_level_2_min: 30,
        no_motion_level_3_min: 60,
        safety_ceiling_hours: 4,
        night_mode_enabled: false,
        test_mode: false,
        emergency_repeat_interval_min: 5,
        is_active: true,
        seed_tag: SEED_TAG,
      },
      { upsert: true, new: true },
    );
    console.log(`  ✓ 1 room settings doc`);

    // Alerts
    console.log(`[9/12] Generating alerts...`);
    const alerts = generate_alerts(profile, rid, devs);
    if (alerts.length > 0) {
      await AlertLog.deleteMany({ resident: rid, seed_tag: SEED_TAG });
      await AlertLog.insertMany(alerts, { ordered: false });
    }
    console.log(`  ✓ ${alerts.length} alerts (${alerts.filter(a => a.resolution_reason === 'false_positive').length} false_positive, ${alerts.filter(a => a.resolution_reason === 'confirmed_concern').length} confirmed_concern)`);
    total_alerts += alerts.length;

    // Monthly summaries
    console.log(`[10/12] Computing monthly summaries...`);
    const summaries = generate_monthly_summaries(sleep, bp, alerts, rid);
    if (summaries.length > 0) {
      await MonthlySummary.deleteMany({ resident: rid, seed_tag: SEED_TAG });
      await MonthlySummary.insertMany(summaries, { ordered: false });
    }
    console.log(`  ✓ ${summaries.length} monthly summaries`);
    total_summaries += summaries.length;

    // Raw GLK logs
    console.log(`[11/12] Generating raw GLK health logs...`);
    const glk_logs = generate_glk_raw_logs(profile, rid, sr_nums[i]);
    if (glk_logs.length > 0) {
      await UnknownRouteLog.deleteMany({ 'body.serialnumber': sr_nums[i], seed_tag: SEED_TAG });
      // Insert in batches (GLK logs can be large)
      const batch_size = 5000;
      for (let b = 0; b < glk_logs.length; b += batch_size) {
        await UnknownRouteLog.insertMany(glk_logs.slice(b, b + batch_size), { ordered: false });
      }
    }
    console.log(`  ✓ ${glk_logs.length} raw GLK health logs`);
    total_glk += glk_logs.length;

    // Zigbee logs
    console.log(`[12/12] Generating Zigbee logs...`);
    const z_logs = generate_zigbee_logs(profile, devs);
    if (z_logs.length > 0) {
      await ZigbeeLog.deleteMany({ seed_tag: SEED_TAG, 'data.occupancy_group': `washroom_r${i}` });
      await ZigbeeLog.insertMany(z_logs, { ordered: false });
    }
    console.log(`  ✓ ${z_logs.length} Zigbee logs`);
    total_zigbee += z_logs.length;
  }

  // Dashboard section views (account-level, not per-resident)
  console.log('\n[bonus] Generating dashboard section views...');
  const views = generate_dashboard_views();
  if (views.length > 0) {
    await DashboardSectionView.deleteMany({ seed_tag: SEED_TAG });
    await DashboardSectionView.insertMany(views, { ordered: false });
  }
  console.log(`  ✓ ${views.length} dashboard section views`);

  // ── Summary ──
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  SEED COMPLETE');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  User:              1`);
  console.log(`  Home:              1`);
  console.log(`  Residents:         3`);
  console.log(`  Devices:           13`);
  console.log(`  Sleep Sessions:    ${total_sleep}`);
  console.log(`  BP Readings:       ${total_bp}`);
  console.log(`  Occupancy Events:  ${total_events}`);
  console.log(`  Occupancy States:  3`);
  console.log(`  Occupancy Settings:3`);
  console.log(`  Alerts:            ${total_alerts}`);
  console.log(`  Monthly Summaries: ${total_summaries}`);
  console.log(`  Dashboard Views:   ${views.length}`);
  console.log(`  GLK Raw Logs:      ${total_glk}`);
  console.log(`  Zigbee Logs:       ${total_zigbee}`);
  console.log('');
  console.log('  AI Features Coverage:');
  console.log('    Part 3  Daily Narrative        ✓ sleep_sessions + alerts + bp_readings');
  console.log('    Part 4  Ask Abhi on Alerts     ✓ alerts with resolution_reason');
  console.log('    Part 5  Ask Abhi Chatbot       ✓ all collections queryable');
  console.log('    Part 6  Monthly Review          ✓ monthly_summaries');
  console.log('    Part 7  Doctor Report           ✓ monthly_summaries + bp_readings + sleep');
  console.log('    Part 8  Adaptive Threshold      ✓ alerts (false_positive + confirmed_concern)');
  console.log('    Part 9  Personalised Insight    ✓ dashboard_section_views');
  console.log('    Part 10 Ask Abhi on Graphs      ✓ all time-series data');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`\n  To clean up: node seed_ai_dev_data.js --cleanup`);
}

// ═══════════════════════════════════════════════════════════════════════
// ENTRYPOINT
// ═══════════════════════════════════════════════════════════════════════
async function main() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log(`Connected to MongoDB: ${MONGO_URI}\n`);

    const arg = process.argv[2];
    if (arg === '--cleanup') {
      await cleanup();
    } else if (arg === '--drop') {
      await cleanup();
      await seed();
    } else {
      await seed();
    }
  } catch (err) {
    console.error('FATAL:', err);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB.');
  }
}

main();
