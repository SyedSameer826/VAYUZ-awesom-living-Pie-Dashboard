/**
 * Awesom Living — Bathroom Occupancy & Inactivity state machine
 * Implements Specification v4.0 (27 Sep 2026) — TWO SENSORS, NO DOOR CONTACT.
 * Normative source: the spec PDF. v4 supersedes v3 and bathroom_watch v2.1.
 *
 * Pure logic. No MQTT, no DB, no sockets, no timers of its own.
 * Wire it into the existing pipeline:
 *
 *   const { BathroomOccupancy, ROLES } = require('./occupancyStateMachine');
 *   const sm = new BathroomOccupancy({ roomId, homeId }, evt => dispatch(evt));
 *
 *   // on every Zigbee event, using the PI's timestamp (not arrival time):
 *   sm.onSensor(ROLES.DOORWAY, payload.occupancy === true, piTsMs, { retained });
 *   sm.onSensor(ROLES.INSIDE,  payload.occupancy === true, piTsMs);
 *   sm.onAvailability(ROLES.INSIDE, online, piTsMs);
 *
 *   // after every event AND from the existing 30 s cron:
 *   sm.tick(Date.now());
 *
 *   // persistence (survives restarts):
 *   await save(sm.snapshot());     // whenever sm.dirty === true
 *   sm.restore(saved);             // on boot
 *
 * Every emitted event carries { audience }:
 *   'family'  -> push notification        (see spec 5.2 for channel/loudness)
 *   'ops'     -> operations dashboard only
 *   'none'    -> log + socket state update only. NEVER a push.
 */

'use strict';

const ROLES = { DOORWAY: 'doorway', INSIDE: 'inside' };

const STATES = {
  VACANT: 'VACANT',
  TENTATIVE: 'TENTATIVE',
  OCCUPIED: 'OCCUPIED',
  EXIT_PENDING: 'EXIT_PENDING',
  CHECKING: 'CHECKING',
  ALERTED: 'ALERTED',
  AWAY: 'AWAY',
  DEGRADED: 'DEGRADED',
};

/** Production values — spec section 4. Seconds unless stated. */
const DEFAULTS = {
  roomId: 'bathroom',
  homeId: null,

  tentativeConfirmS: 60,
  crossingGraceS: 4,
  insideTimeoutS: 5,
  exitConfirmS: 45,
  exitRestartMax: 3,

  silenceDayS: 900,
  silenceNightS: 600,
  nightStart: '22:00',
  nightEnd: '06:00',

  chimeEnabled: true,
  checkWindowS: 90,
  checkAttempts: 2,
  alertRepeatS: 300,

  longStayS: [2700, 3600, 5400], // 45 / 60 / 90 min
  safetyCeilingS: 14400,         // 4 h

  sensorOfflineS: 1800,
  restoreMaxS: 7200,

  timezoneOffsetMin: 330, // IST. Night window is evaluated in the HOME's local time.
};

/** Test-mode values — spec 4, table footnote. Never reachable in production config. */
const TEST_MODE = {
  tentativeConfirmS: 20,
  exitConfirmS: 15,
  silenceDayS: 60,
  silenceNightS: 60,
  checkWindowS: 20,
  longStayS: [180, 210, 240],
  safetyCeilingS: 600,
  alertRepeatS: 30,
};

const S = (sec) => sec * 1000;

function hhmmToMin(s) {
  const [h, m] = String(s).split(':').map(Number);
  return h * 60 + m;
}

class BathroomOccupancy {
  /**
   * @param {object} cfg   overrides for DEFAULTS (+ roomId, homeId)
   * @param {(evt:object)=>void} emit  called for every event; must not throw
   */
  constructor(cfg, emit) {
    this.cfg = Object.assign({}, DEFAULTS, cfg || {});
    if (this.cfg.testMode) Object.assign(this.cfg, TEST_MODE);
    this._emit = emit || (() => {});
    this.validate();

    this.state = STATES.VACANT;
    this.prev = { doorway: null, inside: null };
    this.insideActive = false;
    this.offline = new Set();
    this.lastSeen = {};          // role -> ts
    this.away = false;
    this.dirty = false;
    this.testModeUntil = null;   // anchored on the first tick, to the injected clock
    this._resetVisit();
  }

  validate() {
    const c = this.cfg;
    if (c.exitConfirmS < c.crossingGraceS + c.insideTimeoutS + 5)
      throw new Error('exitConfirmS must exceed crossingGraceS + insideTimeoutS + 5');
    if (c.checkAttempts < 1) throw new Error('checkAttempts must be >= 1');
    if (!Array.isArray(c.longStayS) || c.longStayS.length !== 3)
      throw new Error('longStayS must be three ascending values');
    for (let i = 1; i < 3; i++)
      if (c.longStayS[i] <= c.longStayS[i - 1]) throw new Error('longStayS must ascend');
    if (c.silenceDayS < 600 || c.silenceNightS < 480) {
      if (!c.testMode) throw new Error('silence thresholds below the safety floor (spec 4.2)');
    }
  }

  // ---------------------------------------------------------------- helpers
  _resetVisit() {
    this.enteredAt = null;
    this.tentativeStart = null;
    this.tentativeSince = null;
    this.lastMotion = null;
    this.exitStarted = null;
    this.exitRestarts = 0;
    this.checkStarted = null;
    this.attempt = 0;
    this.alertedAt = null;
    this.lastAlert = null;
    this.maxSilence = 0;
    this.longStayFired = [false, false, false];
    this.ceilingFired = false;
    this.insideRises = 0;
    this.degradedNotified = false;
  }

  emit(type, now, data = {}, audience = 'none') {
    this.dirty = true;
    this._emit(Object.assign({
      type,
      audience,                        // 'family' | 'ops' | 'none'
      roomId: this.cfg.roomId,
      homeId: this.cfg.homeId,
      state: this.state,
      ts: new Date(now).toISOString(),
      tsMs: now,
      occupiedS: this.enteredAt == null ? null : Math.round((now - this.enteredAt) / 1000),
      silenceS: Math.round(this.silence(now) / 1000),
      testMode: !!this.cfg.testMode,
    }, data));
  }

  isNight(now) {
    const local = new Date(now + this.cfg.timezoneOffsetMin * 60000);
    const cur = local.getUTCHours() * 60 + local.getUTCMinutes();
    const a = hhmmToMin(this.cfg.nightStart), b = hhmmToMin(this.cfg.nightEnd);
    return a < b ? cur >= a && cur < b : cur >= a || cur < b;
  }

  threshold(now) {
    return S(this.isNight(now) ? this.cfg.silenceNightS : this.cfg.silenceDayS);
  }

  silence(now) {
    if (this.insideActive || this.lastMotion == null) return 0;
    return Math.max(0, now - this.lastMotion);
  }

  // ----------------------------------------------------------------- inputs
  /**
   * @param {string} role   ROLES.DOORWAY | ROLES.INSIDE | ROLES.DOOR
   * @param {boolean} value occupancy true/false
   * @param {number} nowMs  the PI's timestamp for this event
   * @param {object} [opts] { retained:boolean }
   */
  onSensor(role, value, nowMs, opts = {}) {
    const now = nowMs;
    this.lastSeen[role] = now;
    if (this.offline.has(role)) this.onAvailability(role, true, now);

    const prev = this.prev[role];
    this.prev[role] = value;

    // Retained messages and the first value after a restart are RECORDED ONLY.
    // Z2M republishes the whole cached state on any report (e.g. battery), so
    // only a real false->true edge counts as motion.
    if (opts.retained || prev === null) {
      if (role === ROLES.INSIDE && !value) this.insideActive = false;
      return;
    }

    if (value && !prev) {
      role === ROLES.DOORWAY ? this._doorwayRise(now) : this._insideRise(now);
    } else if (role === ROLES.INSIDE && prev && !value) {
      this.insideActive = false;
      const last = now - S(this.cfg.insideTimeoutS);
      this.lastMotion = this.lastMotion == null ? last : Math.max(this.lastMotion, last);
    }
  }

  onAvailability(role, online, nowMs) {
    const now = nowMs;
    if (online && this.offline.has(role)) {
      this.offline.delete(role);
      this.lastSeen[role] = now;
      this.emit('sensor_online', now, { sensor: role }, 'ops');
      if (this.state === STATES.DEGRADED) {
        this.state = STATES.OCCUPIED;
        this.lastMotion = now;                 // don't punish the visit for our blindness
        this.emit('monitoring_restored', now, { sensor: role }, 'ops');
      }
    } else if (!online && !this.offline.has(role)) {
      this.offline.add(role);
      this.emit('sensor_offline', now, { sensor: role }, 'ops');
    }
  }

  /** Spec 6.8 — family-set Away. Never inferred from sensor silence. */
  setAway(away, nowMs) {
    this.away = !!away;
    if (this.away) {
      this.state = STATES.AWAY;
      this._resetVisit();
      this.emit('away_enabled', nowMs, {}, 'none');
    } else {
      this.state = STATES.VACANT;
      this.emit('away_disabled', nowMs, {}, 'none');
    }
  }

  // ------------------------------------------------------------ transitions
  _tentative(now, via) {
    this._resetVisit();
    this.state = STATES.TENTATIVE;
    this.tentativeStart = this.tentativeSince = now;
    this.emit('entry_tentative', now, { via }, 'none');
  }

  _confirm(now, how) {
    const start = this.tentativeStart;
    this.state = STATES.OCCUPIED;
    this.enteredAt = start;                     // spec 3.3: from first trigger
    this.lastMotion = now;
    this.tentativeStart = this.tentativeSince = null;
    this.insideRises = 1;
    this.emit('entry', now, { confirmedBy: how }, 'none');
  }

  _doorwayRise(now) {
    this.lastMotion = now;
    switch (this.state) {
      case STATES.VACANT:
        this._tentative(now, 'doorway'); break;
      case STATES.TENTATIVE:
        this.tentativeSince = now; break;
      case STATES.OCCUPIED:
      case STATES.DEGRADED:
        this._startExit(now); break;
      case STATES.CHECKING:
        this.emit('check_resolved', now, { by: 'doorway', attempt: this.attempt }, 'none');
        this._startExit(now); break;
      case STATES.ALERTED:
        this._allClear(now, 'doorway');
        this._startExit(now); break;
      case STATES.EXIT_PENDING:
        if (this.exitRestarts < this.cfg.exitRestartMax) {  // spec 3.4: capped
          this.exitRestarts += 1;
          this.exitStarted = now;
        }
        break;
      default: break;                                       // AWAY: ignore
    }
  }

  _insideRise(now) {
    this.insideActive = true;
    this.lastMotion = now;
    switch (this.state) {
      case STATES.VACANT:
        this._resetVisit();                                 // safety net (spec 3.2)
        this.state = STATES.OCCUPIED;
        this.enteredAt = now;
        this.lastMotion = now;
        this.insideRises = 1;
        this.emit('entry', now, { confirmedBy: 'inside_only' }, 'none');
        break;
      case STATES.TENTATIVE:
        this._confirm(now, 'inside_motion');
        break;
      case STATES.OCCUPIED:
      case STATES.DEGRADED:
        this.insideRises += 1;
        if (this.state === STATES.DEGRADED) this.state = STATES.OCCUPIED;
        break;
      case STATES.EXIT_PENDING:
        this.insideRises += 1;
        if (now - this.exitStarted > S(this.cfg.crossingGraceS))
          this._backToOccupied(now, 'movement_inside');
        break;
      case STATES.CHECKING:
        this.emit('check_resolved', now, { by: 'inside', attempt: this.attempt }, 'none');
        this.state = STATES.OCCUPIED;
        this.checkStarted = null; this.attempt = 0;
        break;
      case STATES.ALERTED:
        this._allClear(now, 'inside');
        this.state = STATES.OCCUPIED;
        break;
      default: break;
    }
  }

  _startExit(now) {
    this.state = STATES.EXIT_PENDING;
    this.exitStarted = now;
    this.checkStarted = null;
    this.attempt = 0;
    this.emit('exit_pending', now, {}, 'none');
  }

  _backToOccupied(now, reason) {
    this.state = STATES.OCCUPIED;
    this.exitStarted = null;
    this.emit('exit_cancelled', now, { reason }, 'none');
  }

  _allClear(now, by) {
    // Spec 5.3 — automatic, within seconds, to everyone who got the alert.
    this.emit('all_clear', now, { by, alertedForS: Math.round((now - this.alertedAt) / 1000) }, 'family');
    this.alertedAt = this.lastAlert = null;
    this.attempt = 0;
  }

  _startCheck(now) {
    if (!this.cfg.chimeEnabled) { this._escalate(now); return; }
    this.state = STATES.CHECKING;
    this.attempt = 1;
    this.checkStarted = now;
    this.emit('check_started', now, { attempt: 1, chime: 'soft' }, 'none');
  }

  _escalate(now) {
    this.state = STATES.ALERTED;
    this.alertedAt = this.lastAlert = now;
    this.emit('inactivity_alert', now, {
      reason: 'prolonged_inactivity_bathroom',
      subject: 'someone',
      checkAttempts: this.attempt,
      insideRises: this.insideRises,
      night: this.isNight(now),
      sensorsOffline: [...this.offline],
      requiresAck: true,
      critical: true,                 // must override silent / DND (spec 5.2)
    }, 'family');
  }

  // ------------------------------------------------------------------- tick
  /** Call after every sensor event and from the 30 s cron. */
  tick(nowMs) {
    const now = nowMs, c = this.cfg;

    if (this.cfg.testMode && this.testModeUntil == null) this.testModeUntil = now + S(1800);
    if (this.testModeUntil && now > this.testModeUntil) {   // spec 6.10
      this.cfg.testMode = false;
      this.testModeUntil = null;
      Object.assign(this.cfg, DEFAULTS, { roomId: c.roomId, homeId: c.homeId });
      this.emit('test_mode_expired', now, {}, 'ops');
    }
    if (this.state === STATES.AWAY) return;

    // Blind-sensor guard (spec 6.1): never alert on the silence of a sensor we cannot hear.
    if ([STATES.OCCUPIED, STATES.CHECKING, STATES.EXIT_PENDING].includes(this.state)) {
      const seen = this.lastSeen[ROLES.INSIDE];
      const blind = this.offline.has(ROLES.INSIDE) ||
        (seen != null && now - seen > S(c.sensorOfflineS));
      if (blind) {
        if (this.state !== STATES.DEGRADED) {
          this.state = STATES.DEGRADED;
          this.emit('monitoring_degraded', now, {
            sensor: ROLES.INSIDE, reason: 'sensor_unreachable',
          }, 'ops');
        }
        return;
      }
    }

    if (this.state === STATES.TENTATIVE) {
      if (this.insideActive && now - this.tentativeSince >= S(c.insideTimeoutS + 3)) {
        this._confirm(now, 'sustained_motion');
      } else if (now - this.tentativeSince >= S(c.tentativeConfirmS)) {
        this.state = STATES.VACANT;
        this.emit('entry_unconfirmed', now, {
          tentativeS: Math.round((now - this.tentativeStart) / 1000),
        }, 'none');
        this._resetVisit();
      }
      return;
    }

    if (this.state === STATES.EXIT_PENDING) {
      const el = now - this.exitStarted;
      if (this.insideActive && el >= S(c.crossingGraceS + c.insideTimeoutS + 3)) {
        this._backToOccupied(now, 'still_moving_inside');
      } else if (el >= S(c.exitConfirmS)) {
        this.state = STATES.VACANT;
        this.emit('exit', now, {
          maxSilenceS: Math.round(this.maxSilence / 1000),
          insideRises: this.insideRises,
        }, 'none');
        this._resetVisit();
      }
      return;
    }

    if ([STATES.OCCUPIED, STATES.CHECKING, STATES.ALERTED].includes(this.state)) {
      this.maxSilence = Math.max(this.maxSilence, this.silence(now));
      const heldS = (now - this.enteredAt) / 1000;

      for (let i = 0; i < 3; i++) {                            // long stay ladder
        if (!this.longStayFired[i] && heldS >= c.longStayS[i]) {
          this.longStayFired[i] = true;
          this.emit('long_stay', now, {
            level: i + 1, minutes: Math.round(heldS / 60),
            requiresAck: i === 2, critical: i === 2,
          }, 'family');
        }
      }
      if (!this.ceilingFired && heldS >= c.safetyCeilingS) {
        this.ceilingFired = true;
        this.emit('safety_ceiling', now, {
          hours: +(heldS / 3600).toFixed(1), requiresAck: true, critical: true,
        }, 'family');
      }
    }

    if (this.state === STATES.OCCUPIED) {
      if (this.silence(now) >= this.threshold(now)) this._startCheck(now);
    } else if (this.state === STATES.CHECKING) {
      if (now - this.checkStarted >= S(c.checkWindowS)) {
        if (this.attempt < c.checkAttempts) {
          this.attempt += 1;
          this.checkStarted = now;
          this.emit('check_repeat', now, { attempt: this.attempt, chime: 'louder' }, 'none');
        } else {
          this._escalate(now);
        }
      }
    } else if (this.state === STATES.ALERTED) {
      if (now - this.lastAlert >= S(c.alertRepeatS)) {
        this.lastAlert = now;
        this.emit('alert_repeat', now, {
          alertedForS: Math.round((now - this.alertedAt) / 1000),
          requiresAck: true, critical: true,
        }, 'family');
      }
    }
  }

  /** Family acknowledgement: stops repeats, does not change room state (spec 5.4). */
  acknowledge(nowMs, byUserId) {
    if (this.state !== STATES.ALERTED) return false;
    this.lastAlert = Number.POSITIVE_INFINITY;
    this.emit('alert_acknowledged', nowMs, { byUserId }, 'none');
    return true;
  }

  // ------------------------------------------------------------ persistence
  static get TIME_FIELDS() {
    return ['enteredAt', 'tentativeStart', 'tentativeSince', 'lastMotion', 'exitStarted',
      'checkStarted', 'alertedAt', 'lastAlert'];
  }

  snapshot(nowMs = Date.now()) {
    const d = {
      v: 4, savedAt: nowMs, state: this.state, attempt: this.attempt,
      maxSilence: this.maxSilence, longStayFired: this.longStayFired,
      ceilingFired: this.ceilingFired, insideRises: this.insideRises,
      exitRestarts: this.exitRestarts, away: this.away, lastSeen: this.lastSeen,
    };
    for (const k of BathroomOccupancy.TIME_FIELDS) d[k] = this[k];
    return d;
  }

  /** Spec 6.4/6.5 — restore only if recent AND the clock is plausible. */
  restore(d, nowMs = Date.now()) {
    if (!d || d.v !== 4) return false;
    if (nowMs < Date.UTC(2026, 0, 1)) return false;                 // clock not set
    if (d.savedAt > nowMs + 60000) return false;                    // from the future
    if (nowMs - d.savedAt > S(this.cfg.restoreMaxS)) return false;  // stale
    if (!Object.values(STATES).includes(d.state)) return false;

    this.state = d.state;
    for (const k of ['attempt', 'maxSilence', 'longStayFired', 'ceilingFired', 'insideRises',
      'exitRestarts', 'away'])
      if (d[k] !== undefined) this[k] = d[k];
    for (const k of BathroomOccupancy.TIME_FIELDS) this[k] = d[k] ?? null;
    this.lastSeen = d.lastSeen || {};
    if (this.state === STATES.TENTATIVE && this.tentativeSince == null) this.state = STATES.VACANT;
    if ([STATES.OCCUPIED, STATES.CHECKING, STATES.ALERTED, STATES.EXIT_PENDING, STATES.DEGRADED]
      .includes(this.state) && this.enteredAt == null) {
      this.state = STATES.VACANT;
      this._resetVisit();
    }
    return true;
  }
}

module.exports = { BathroomOccupancy, ROLES, STATES, DEFAULTS, TEST_MODE };
