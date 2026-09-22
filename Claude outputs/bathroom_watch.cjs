/**
 * Awesom Living — bathroom watch v2.1 (Node.js port)
 *
 * Pure state machine — no I/O, no DB, no MQTT. Inject emit(), sound(), clocks.
 * Fully testable with a fake clock, identical behaviour to bathroom_watch.py.
 *
 * Uses ONLY three bathroom devices:
 *   bath_doorway : SNZB-03P curtain sensor across the doorway  (occupancy)
 *   bath_inside  : SNZB-03P inside, aimed at the floor         (occupancy)
 *   bath_door    : SNZB-04P door contact                       (contact: true = closed)
 *
 * States: EMPTY → TENTATIVE → OCCUPIED → EXIT_PENDING → EMPTY
 *                  OCCUPIED → CHECKING (chime) → ALERTED
 *
 * Alerts always say "someone" and "prolonged inactivity" — never "fall".
 */

'use strict';

// ── States ──────────────────────────────────────────────────────────────────
const EMPTY        = 'EMPTY';
const TENTATIVE    = 'TENTATIVE';
const OCCUPIED     = 'OCCUPIED';
const EXIT_PENDING = 'EXIT_PENDING';
const CHECKING     = 'CHECKING';
const ALERTED      = 'ALERTED';

// ── Defaults (mirrors bathroom.json / Python DEFAULTS) ──────────────────────
const DEFAULTS = {
  mqtt_host: 'localhost',
  mqtt_port: 1883,
  mqtt_user: null,
  mqtt_password: null,
  z2m_base: 'zigbee2mqtt',
  doorway_name: 'bath_doorway',
  inside_name: 'bath_inside',
  door_name: 'bath_door',
  sounder_name: 'hall_sounder',
  sounder_payloads: [
    { warning: { mode: 'emergency', level: 'low',    strobe: false, duration: 2 } },
    { warning: { mode: 'emergency', level: 'medium', strobe: false, duration: 3 } },
  ],
  events_topic: 'awesom/bathroom/events',
  state_topic: 'awesom/bathroom/state',
  status_topic: 'awesom/bathroom/status',
  state_file: '/data/awesom/bathroom_state.json',
  event_log: '/data/awesom/bathroom_events.jsonl',
  event_log_max_bytes: 5_000_000,
  // Timing (seconds)
  silence_s_day: 900,
  silence_s_night: 600,
  night_start: '22:00',
  night_end: '06:00',
  check_window_s: 90,
  check_attempts: 2,
  exit_confirm_s: 45,
  crossing_grace_s: 4,
  inside_timeout_s: 5,
  entry_transient_s: 15,
  door_blocks_exit: true,
  door_open_window_s: 30,
  tentative_confirm_s: 60,
  door_swing_s: 2,
  door_open_starts_tentative: true,
  long_visit_s: 3600,
  alert_repeat_s: 300,
  restore_max_s: 7200,
  tick_s: 2,
};

// ── Validation ──────────────────────────────────────────────────────────────

function validate(cfg) {
  const g = cfg.crossing_grace_s;
  const t = cfg.inside_timeout_s;
  if (cfg.exit_confirm_s < g + t + 10) {
    throw new Error('exit_confirm_s must be >= crossing_grace_s + inside_timeout_s + 10');
  }
  if (cfg.check_attempts < 1) {
    throw new Error('check_attempts must be >= 1');
  }
  for (const k of ['silence_s_day', 'silence_s_night', 'check_window_s']) {
    if (cfg[k] <= 0) throw new Error(k + ' must be > 0');
  }
  for (const k of ['night_start', 'night_end']) {
    const parts = cfg[k].split(':');
    parseInt(parts[0], 10);
    parseInt(parts[1], 10);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _hm(s) {
  const parts = s.split(':');
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

// ── BathroomWatch class ─────────────────────────────────────────────────────

class BathroomWatch {
  /**
   * @param {Object}   cfg   - merged config (DEFAULTS + overrides)
   * @param {Function} emit  - called with event record objects
   * @param {Function|null} sound - called with attempt number (1-based), null if no sounder
   * @param {Function} clock - monotonic clock returning seconds (default: Date.now()/1000)
   * @param {Function} wall  - wall clock returning unix timestamp (default: Date.now()/1000)
   */
  constructor(cfg, emit, sound = null, clock = null, wall = null) {
    this.cfg = cfg;
    this._emit = emit;
    this._sound = sound;
    this.clock = clock || (() => Date.now() / 1000);
    this.wall  = wall  || (() => Date.now() / 1000);

    this.state = EMPTY;
    this.prev = { doorway: null, inside: null, door: null };
    this.inside_active = false;
    this.door_closed = null;           // null = unknown
    this.last_door_open = null;
    this.last_door_event = null;       // last real open/close change
    this.offline = new Set();
    this.dirty = false;
    this._reset_visit();
  }

  // ---------- helpers ----------

  _reset_visit() {
    this.entered_at = null;
    this.tentative_start = null;
    this.tentative_since = null;
    this.last_motion = null;
    this.exit_started = null;
    this.check_started = null;
    this.attempt = 0;
    this.alerted_at = null;
    this.last_alert = null;
    this.max_silence = 0.0;
    this.long_visit_sent = false;
    this.inside_rises = 0;
    this.moved_after_entry = false;
  }

  emit(event, data = {}) {
    const now = this.clock();
    const wall_now = this.wall();
    const dt = new Date(wall_now * 1000);
    const rec = {
      ts: dt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      event,
      state: this.state,
    };
    if (this.entered_at !== null) {
      rec.occupied_s = Math.floor(now - this.entered_at);
    }
    Object.assign(rec, data);
    this.dirty = true;
    this._emit(rec);
  }

  is_night() {
    const wall_now = this.wall();
    const dt = new Date(wall_now * 1000);
    const cur = dt.getHours() * 60 + dt.getMinutes();
    const a = _hm(this.cfg.night_start);
    const b = _hm(this.cfg.night_end);
    if (a < b) {
      return cur >= a && cur < b;
    }
    return cur >= a || cur < b;
  }

  threshold() {
    return this.is_night() ? this.cfg.silence_s_night : this.cfg.silence_s_day;
  }

  silence(now) {
    if (this.inside_active || this.last_motion === null) {
      return 0.0;
    }
    return Math.max(0.0, now - this.last_motion);
  }

  _door_allows_exit(now) {
    if (!this.cfg.door_blocks_exit || !this.cfg.door_name) {
      return true;
    }
    if (this.door_closed === null || this.offline.has('door')) {
      return true;   // unknown -> don't block
    }
    if (!this.door_closed) {
      return true;   // open now
    }
    if (this.last_door_open === null) {
      return false;
    }
    return this.last_door_open >= this.exit_started - this.cfg.door_open_window_s;
  }

  // ---------- inputs ----------

  on_sensor(kind, value, retained = false) {
    const now = this.clock();
    const prev = this.prev[kind];
    this.prev[kind] = value;

    if (kind === 'door') {
      this.door_closed = Boolean(value);
      if (!value) {
        this.last_door_open = now;
      }
      if (prev !== null && prev !== value && !retained) {
        this.last_door_event = now;
        this.emit(value ? 'door_closed' : 'door_opened');
        if (this.state === TENTATIVE) {
          this.tentative_since = now;
        } else if (
          this.state === EMPTY &&
          !value &&
          this.cfg.door_open_starts_tentative
        ) {
          this._tentative(now, 'door');
        }
      }
      return;
    }

    if (retained || prev === null) {
      // First value after start or a retained message: record only, never act.
      if (kind === 'inside' && !value) {
        this.inside_active = false;
      }
      return;
    }

    if (value && !prev) {
      if (kind === 'doorway') {
        this._doorway_rise(now);
      } else {
        this._inside_rise(now);
      }
    } else if (kind === 'inside' && prev && !value) {
      this._inside_fall(now);
    }
  }

  on_availability(kind, online) {
    if (online && this.offline.has(kind)) {
      this.offline.delete(kind);
      this.emit('sensor_online', { sensor: kind });
    } else if (!online && !this.offline.has(kind)) {
      this.offline.add(kind);
      this.emit('sensor_offline', { sensor: kind });
    }
  }

  // ---------- transitions ----------

  _tentative(now, via) {
    this._reset_visit();
    this.state = TENTATIVE;
    this.tentative_start = now;
    this.tentative_since = now;
    this.emit('entry_tentative', { via });
  }

  _confirm(now, how) {
    const start = this.tentative_start;
    this.state = OCCUPIED;
    this.entered_at = start;
    this.last_motion = now;
    this.tentative_start = null;
    this.tentative_since = null;
    this.emit('entry', { via: 'doorway', confirmed_by: how });
  }

  _near_door_event(now) {
    return (
      this.last_door_event !== null &&
      Math.abs(now - this.last_door_event) <= this.cfg.door_swing_s
    );
  }

  _enter(now, via) {
    this._reset_visit();
    this.state = OCCUPIED;
    this.entered_at = now;
    this.last_motion = now;
    this.emit('entry', { via });
  }

  _start_exit(now) {
    this.state = EXIT_PENDING;
    this.exit_started = now;
    this.check_started = null;
    this.attempt = 0;
    this.emit('exit_pending');
  }

  _back_to_occupied(now, reason) {
    this.state = OCCUPIED;
    this.exit_started = null;
    this.emit('exit_cancelled', { reason });
  }

  _doorway_rise(now) {
    this.last_motion = now;
    const s = this.state;

    if (s === EMPTY) {
      this._tentative(now, 'doorway');
    } else if (s === TENTATIVE) {
      this.tentative_since = now;   // another crossing: restart window
    } else if (s === OCCUPIED) {
      this._start_exit(now);
    } else if (s === CHECKING) {
      this.emit('check_resolved', { by: 'doorway', attempt: this.attempt });
      this._start_exit(now);
    } else if (s === ALERTED) {
      this.emit('activity_after_alert', { by: 'doorway' });
      this._start_exit(now);
    } else if (s === EXIT_PENDING) {
      this.exit_started = now;       // another crossing: restart timer
    }
  }

  _inside_rise(now) {
    this.inside_active = true;
    this.last_motion = now;
    const s = this.state;

    if (s === EMPTY) {
      this._enter(now, 'inside');    // doorway missed it
      this.inside_rises = 1;
      return;
    }

    if (s === TENTATIVE) {
      if (!this._near_door_event(now)) {
        this._confirm(now, 'inside_motion');
        this.inside_rises = 1;
      }
      return;                        // door-swing coincident: ignore
    }

    this.inside_rises += 1;
    if (
      this.entered_at !== null &&
      now - this.entered_at > this.cfg.entry_transient_s
    ) {
      this.moved_after_entry = true;
    }

    if (s === EXIT_PENDING) {
      if (now - this.exit_started > this.cfg.crossing_grace_s) {
        this._back_to_occupied(now, 'movement_inside');
      }
      // else: Zigbee latency inversion from the person leaving - ignore
    } else if (s === CHECKING) {
      this.emit('check_resolved', { by: 'inside', attempt: this.attempt });
      this.state = OCCUPIED;
      this.check_started = null;
      this.attempt = 0;
    } else if (s === ALERTED) {
      this.emit('activity_after_alert', { by: 'inside' });
      this.state = OCCUPIED;
      this.alerted_at = null;
      this.last_alert = null;
      this.attempt = 0;
    }
  }

  _inside_fall(now) {
    this.inside_active = false;
    const last = now - this.cfg.inside_timeout_s;
    this.last_motion =
      this.last_motion === null ? last : Math.max(this.last_motion, last);
  }

  _start_check(now) {
    if (!this.cfg.sounder_name || this._sound === null) {
      this._escalate(now);
      return;
    }
    this.state = CHECKING;
    this.attempt = 1;
    this.check_started = now;
    this.emit('check_started', {
      attempt: 1,
      silence_s: Math.floor(this.silence(now)),
    });
    this._sound(1);
  }

  _escalate(now) {
    this.state = ALERTED;
    this.alerted_at = now;
    this.last_alert = now;
    this.emit('escalate', {
      reason: 'prolonged_inactivity_bathroom',
      subject: 'someone',
      silence_s: Math.floor(this.silence(now)),
      check_attempts: this.attempt,
      moved_after_entry: this.moved_after_entry,
      inside_rises: this.inside_rises,
      night: this.is_night(),
      sensors_offline: Array.from(this.offline).sort(),
    });
  }

  // ---------- clock ----------

  tick() {
    const now = this.clock();
    const c = this.cfg;
    const s = this.state;

    if (s === TENTATIVE) {
      const ref = Math.max(
        this.tentative_since,
        this.last_door_event || 0,
      );
      if (
        this.inside_active &&
        now - ref >= c.inside_timeout_s + 3
      ) {
        this._confirm(now, 'sustained_motion');
      } else if (now - this.tentative_since >= c.tentative_confirm_s) {
        this.state = EMPTY;
        this.emit('entry_unconfirmed', {
          tentative_s: Math.floor(now - this.tentative_start),
        });
        this._reset_visit();
      }
      return;
    }

    if (s === EXIT_PENDING) {
      const el = now - this.exit_started;
      if (
        this.inside_active &&
        el >= c.crossing_grace_s + c.inside_timeout_s + 3
      ) {
        this._back_to_occupied(now, 'still_moving_inside');
      } else if (el >= c.exit_confirm_s) {
        if (this._door_allows_exit(now)) {
          this.state = EMPTY;
          this.emit('exit', { max_silence_s: Math.floor(this.max_silence) });
          this._reset_visit();
          this.dirty = true;
        } else {
          this._back_to_occupied(now, 'door_closed_throughout');
        }
      }
      return;
    }

    if (s === OCCUPIED || s === CHECKING || s === ALERTED) {
      const sil = this.silence(now);
      this.max_silence = Math.max(this.max_silence, sil);
    }

    if (s === OCCUPIED) {
      const sil = this.silence(now);
      if (
        !this.long_visit_sent &&
        now - this.entered_at >= c.long_visit_s
      ) {
        this.long_visit_sent = true;
        this.emit('long_visit', { silence_s: Math.floor(sil) });
      }
      if (sil >= this.threshold()) {
        this._start_check(now);
      }
    } else if (s === CHECKING) {
      const sil = this.silence(now);
      if (now - this.check_started >= c.check_window_s) {
        if (this.attempt < c.check_attempts) {
          this.attempt += 1;
          this.check_started = now;
          this.emit('check_repeat', {
            attempt: this.attempt,
            silence_s: Math.floor(sil),
          });
          this._sound(this.attempt);
        } else {
          this._escalate(now);
        }
      }
    } else if (s === ALERTED) {
      const sil = this.silence(now);
      if (now - this.last_alert >= c.alert_repeat_s) {
        this.last_alert = now;
        this.emit('alert_repeat', {
          silence_s: Math.floor(sil),
          alerted_for_s: Math.floor(now - this.alerted_at),
        });
      }
    }
  }

  // ---------- persistence ----------

  static get _TIMES() {
    return [
      'entered_at', 'last_motion', 'exit_started', 'check_started',
      'alerted_at', 'last_alert', 'last_door_open', 'last_door_event',
      'tentative_start', 'tentative_since',
    ];
  }

  snapshot() {
    const mono = this.clock();
    const wall_val = this.wall();
    const d = {
      v: 3,
      saved_wall: wall_val,
      state: this.state,
      attempt: this.attempt,
      max_silence: this.max_silence,
      long_visit_sent: this.long_visit_sent,
      inside_rises: this.inside_rises,
      moved_after_entry: this.moved_after_entry,
      door_closed: this.door_closed,
    };
    for (const k of BathroomWatch._TIMES) {
      const t = this[k];
      d[k] = t === null ? null : wall_val + (t - mono);
    }
    return d;
  }

  restore(d) {
    const mono = this.clock();
    const wall_val = this.wall();

    // Jan 1, 2026 00:00:00 UTC
    if (wall_val < new Date(2026, 0, 1).getTime() / 1000) {
      return false;   // RTC not set
    }
    if (d.v !== 3 || wall_val - (d.saved_wall || 0) > this.cfg.restore_max_s) {
      return false;
    }
    if ((d.saved_wall || 0) > wall_val + 60) {
      return false;   // snapshot from the future
    }
    const valid_states = [EMPTY, TENTATIVE, OCCUPIED, EXIT_PENDING, CHECKING, ALERTED];
    if (!valid_states.includes(d.state)) {
      return false;
    }

    this.state = d.state;
    for (const k of [
      'attempt', 'max_silence', 'long_visit_sent', 'inside_rises',
      'moved_after_entry', 'door_closed',
    ]) {
      if (k in d) {
        this[k] = d[k];
      }
    }
    for (const k of BathroomWatch._TIMES) {
      const t = d[k] !== undefined ? d[k] : null;
      this[k] = t === null ? null : mono - (wall_val - t);
    }

    if (this.state === TENTATIVE && this.tentative_since === null) {
      this.state = EMPTY;
    }
    if (this.state === CHECKING && this.check_started === null) {
      this.state = OCCUPIED;
    }
    if (
      [OCCUPIED, CHECKING, ALERTED, EXIT_PENDING].includes(this.state) &&
      this.entered_at === null
    ) {
      this.state = EMPTY;
      this._reset_visit();
    }
    return true;
  }
}

module.exports = {
  DEFAULTS,
  EMPTY,
  TENTATIVE,
  OCCUPIED,
  EXIT_PENDING,
  CHECKING,
  ALERTED,
  validate,
  BathroomWatch,
};
