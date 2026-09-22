/**
 * Fake-clock tests — Node.js port of test_bathroom_watch.py (21 tests).
 * Run: node test_bathroom_watch.js
 * No MQTT, no DB needed.
 */

'use strict';

const {
  DEFAULTS, BathroomWatch, EMPTY, TENTATIVE, OCCUPIED, EXIT_PENDING,
  CHECKING, ALERTED, validate,
} = require('./bathroom_watch.cjs');

const BASE_WALL = new Date(2026, 8, 20, 14, 0).getTime() / 1000;  // Sep 20, 2 PM = day

// ── Test rig (mirrors Python Rig) ───────────────────────────────────────────

class Rig {
  constructor(start_wall = BASE_WALL, overrides = {}) {
    this.cfg = { ...DEFAULTS, ...overrides };
    validate(this.cfg);
    this.t = 1000.0;
    this.w0 = start_wall;
    this.events = [];
    this.sounds = [];
    this.w = this._make();
  }

  _make() {
    return new BathroomWatch(
      this.cfg,
      (rec) => this.events.push(rec),
      this.cfg.sounder_name ? (n) => this.sounds.push(n) : null,
      () => this.t,
      () => this.w0 + (this.t - 1000.0),
    );
  }

  adv(s, step = 1.0) {
    const end = this.t + s;
    while (this.t < end) {
      this.t = Math.min(end, this.t + step);
      this.w.tick();
    }
  }

  prime() {
    for (const [k, v] of [['doorway', false], ['inside', false], ['door', false]]) {
      this.w.on_sensor(k, v);
    }
  }

  pir(kind, dur = null) {
    this.w.on_sensor(kind, true);
    this.adv(dur || this.cfg.inside_timeout_s);
    this.w.on_sensor(kind, false);
  }

  enter() {
    this.pir('doorway');
    this.adv(2);
    this.pir('inside');
  }

  names() {
    return this.events.map((e) => e.event);
  }
}

// ── Minimal test runner ─────────────────────────────────────────────────────

let _pass = 0;
let _fail = 0;
let _errors = [];

function assert_eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert_true(val, msg) {
  if (!val) throw new Error(`${msg}: expected truthy, got ${JSON.stringify(val)}`);
}

function assert_false(val, msg) {
  if (val) throw new Error(`${msg}: expected falsy, got ${JSON.stringify(val)}`);
}

function assert_in(item, arr, msg) {
  if (!arr.includes(item)) {
    throw new Error(`${msg}: ${JSON.stringify(item)} not in [${arr.join(', ')}]`);
  }
}

function assert_not_in(item, arr, msg) {
  if (arr.includes(item)) {
    throw new Error(`${msg}: ${JSON.stringify(item)} should not be in [${arr.join(', ')}]`);
  }
}

function assert_throws(fn, msg) {
  let threw = false;
  try { fn(); } catch (e) { threw = true; }
  if (!threw) throw new Error(`${msg}: expected an error to be thrown`);
}

function test(name, fn) {
  try {
    fn();
    _pass++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    _fail++;
    _errors.push({ name, error: e.message });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message}`);
  }
}

// ── 21 tests ────────────────────────────────────────────────────────────────

test('test_still_person_escalates_after_two_chimes', () => {
  const r = new Rig(); r.prime();
  r.enter();
  assert_eq(r.w.state, OCCUPIED, 'state after enter');
  r.adv(900);
  assert_eq(r.w.state, CHECKING, 'state after 900s silence');
  assert_eq(JSON.stringify(r.sounds), JSON.stringify([1]), 'sounds after first check');
  r.adv(90);
  assert_eq(JSON.stringify(r.sounds), JSON.stringify([1, 2]), 'sounds after second check');
  r.adv(90);
  assert_eq(r.w.state, ALERTED, 'state after escalation');
  const esc = r.events.find((e) => e.event === 'escalate');
  assert_eq(esc.subject, 'someone', 'escalate subject');
  assert_eq(esc.reason, 'prolonged_inactivity_bathroom', 'escalate reason');
  r.adv(300);
  assert_in('alert_repeat', r.names(), 'alert_repeat present');
});

test('test_normal_visit_in_and_out_no_alert', () => {
  const r = new Rig(); r.prime();
  r.pir('doorway');
  for (let i = 0; i < 10; i++) {
    r.pir('inside'); r.adv(20);
  }
  r.pir('inside'); r.adv(1);
  r.pir('doorway');   // leaving
  r.adv(60);
  assert_eq(r.w.state, EMPTY, 'state after exit');
  assert_in('exit', r.names(), 'exit event present');
  assert_not_in('check_started', r.names(), 'no check_started');
});

test('test_movement_after_chime_resolves', () => {
  const r = new Rig(); r.prime();
  r.enter();
  r.adv(905);
  assert_eq(r.w.state, CHECKING, 'state is CHECKING');
  r.adv(20);
  r.pir('inside');
  assert_eq(r.w.state, OCCUPIED, 'state back to OCCUPIED');
  assert_in('check_resolved', r.names(), 'check_resolved present');
  assert_not_in('escalate', r.names(), 'no escalate');
});

test('test_missed_doorway_entry_latched_by_inside', () => {
  const r = new Rig(); r.prime();
  r.pir('inside');
  assert_eq(r.w.state, OCCUPIED, 'state after inside-only entry');
  assert_eq(r.events[0].via, 'inside', 'entry via inside');
});

test('test_latency_inversion_on_exit_still_empties', () => {
  const r = new Rig(); r.prime();
  r.enter(); r.adv(30);
  r.w.on_sensor('doorway', true);     // leaving
  r.adv(2);
  r.w.on_sensor('inside', true);      // inside report arrives late, within grace
  r.adv(3); r.w.on_sensor('inside', false);
  r.w.on_sensor('doorway', false);
  r.adv(60);
  assert_eq(r.w.state, EMPTY, 'state after latency inversion exit');
});

test('test_second_person_enters_stays_occupied', () => {
  const r = new Rig(); r.prime();
  r.enter(); r.adv(60);
  r.pir('doorway');        // helper walks in
  r.adv(8);
  r.pir('inside');         // movement inside after grace
  assert_eq(r.w.state, OCCUPIED, 'state after second person');
  r.adv(60);
  assert_eq(r.w.state, OCCUPIED, 'still occupied');
});

test('test_door_closed_throughout_blocks_exit', () => {
  const r = new Rig(); r.prime();
  r.w.on_sensor('door', true);        // closed
  r.enter();
  r.adv(100);
  r.pir('doorway');                    // PIR edge at doorway, but door never opened
  r.adv(60);
  assert_eq(r.w.state, OCCUPIED, 'exit blocked');
  assert_in('exit_cancelled', r.names(), 'exit_cancelled present');
});

test('test_door_opened_allows_exit', () => {
  const r = new Rig(); r.prime();
  r.w.on_sensor('door', true);
  r.enter(); r.adv(100);
  r.w.on_sensor('door', false);       // opens
  r.pir('doorway');
  r.w.on_sensor('door', true);        // closed behind
  r.adv(60);
  assert_eq(r.w.state, EMPTY, 'exit allowed');
});

test('test_quick_in_out_without_stepping_in_clears', () => {
  const r = new Rig(); r.prime();
  r.w.on_sensor('doorway', true);     // in and out within the 5s blind window
  r.adv(5); r.w.on_sensor('doorway', false);
  r.adv(70);
  assert_eq(r.w.state, EMPTY, 'back to EMPTY');
  assert_in('entry_unconfirmed', r.names(), 'entry_unconfirmed present');
  assert_not_in('check_started', r.names(), 'no check_started');
});

test('test_syed_case_open_look_close_walk_away', () => {
  const r = new Rig(); r.prime();
  r.w.on_sensor('door', true);        // door closed, room empty
  r.w.on_sensor('doorway', true);     // curtain PIR sees person at door
  r.adv(1);
  r.w.on_sensor('door', false);       // opens door
  r.adv(1);
  r.w.on_sensor('inside', true);      // inside PIR catches the door swing
  r.adv(2);
  r.w.on_sensor('door', true);        // closes without entering
  r.adv(2); r.w.on_sensor('inside', false);
  r.w.on_sensor('doorway', false);    // walks away
  r.adv(70);
  assert_eq(r.w.state, EMPTY, 'state is EMPTY after look-in');
  assert_not_in('entry', r.names(), 'no entry event');
  r.adv(1000);
  assert_not_in('check_started', r.names(), 'no check_started');
});

test('test_real_entry_door_closed_then_moves_confirms', () => {
  const r = new Rig(); r.prime();
  r.w.on_sensor('door', true);
  r.w.on_sensor('doorway', true); r.adv(1);
  r.w.on_sensor('door', false); r.adv(1);
  r.w.on_sensor('inside', true);      // swing (ignored)
  r.adv(2); r.w.on_sensor('door', true);   // closes from inside
  r.adv(4); r.w.on_sensor('inside', false);
  r.adv(3); r.w.on_sensor('inside', true);  // walks to the toilet
  assert_eq(r.w.state, OCCUPIED, 'state is OCCUPIED after real entry');
  r.adv(5); r.w.on_sensor('inside', false);   // sits still
  r.adv(905);
  assert_eq(r.w.state, CHECKING, 'state is CHECKING after silence');
});

test('test_real_entry_continuous_motion_confirms', () => {
  const r = new Rig(); r.prime();
  r.w.on_sensor('door', true);
  r.w.on_sensor('doorway', true); r.adv(1);
  r.w.on_sensor('door', false); r.adv(1);
  r.w.on_sensor('inside', true);      // swing + walking in, stays active
  r.adv(2); r.w.on_sensor('door', true);
  r.adv(15);
  assert_eq(r.w.state, OCCUPIED, 'sustained motion confirms entry');
});

test('test_door_open_while_empty_is_only_tentative', () => {
  const r = new Rig(); r.prime();
  r.w.on_sensor('door', true);
  r.w.on_sensor('door', false);       // someone opens the door and leaves it open
  assert_eq(r.w.state, TENTATIVE, 'door open = TENTATIVE');
  r.adv(70);
  assert_eq(r.w.state, EMPTY, 'back to EMPTY after timeout');
});

test('test_night_threshold_is_shorter', () => {
  const night = new Date(2026, 8, 20, 23, 0).getTime() / 1000;
  const r = new Rig(night); r.prime();
  r.enter();
  r.adv(605);
  assert_eq(r.w.state, CHECKING, 'CHECKING after 600s night threshold');
});

test('test_no_sounder_escalates_directly', () => {
  const r = new Rig(BASE_WALL, { sounder_name: '' }); r.prime();
  r.enter(); r.adv(905);
  assert_eq(r.w.state, ALERTED, 'direct escalation without sounder');
});

test('test_first_and_retained_messages_do_not_trigger', () => {
  const r = new Rig();
  r.w.on_sensor('doorway', true);             // first value -> record only
  assert_eq(r.w.state, EMPTY, 'first message ignored');
  r.w.on_sensor('doorway', false);
  r.w.on_sensor('doorway', true, true);       // retained
  assert_eq(r.w.state, EMPTY, 'retained message ignored');
});

test('test_repeated_true_reports_are_not_edges', () => {
  const r = new Rig(); r.prime();
  r.w.on_sensor('doorway', true);
  r.w.on_sensor('doorway', true);             // battery report carrying cached occupancy
  assert_eq(r.w.state, TENTATIVE, 'state is TENTATIVE');
  const tentative_count = r.names().filter((n) => n === 'entry_tentative').length;
  assert_eq(tentative_count, 1, 'only one entry_tentative');
});

test('test_restore_after_power_cut', () => {
  const r = new Rig(); r.prime();
  r.enter(); r.adv(300);
  const snap = r.w.snapshot();
  r.t += 400;                                 // outage 400s
  const w2 = r._make();
  assert_true(w2.restore(snap), 'restore succeeds');
  r.w = w2;
  assert_eq(w2.state, OCCUPIED, 'restored state is OCCUPIED');
  r.adv(210);                                 // 300+400+210 > 900 silence
  assert_eq(w2.state, CHECKING, 'silence triggers CHECKING');
});

test('test_stale_snapshot_rejected', () => {
  const r = new Rig(); r.prime();
  r.enter();
  const snap = r.w.snapshot();
  r.t += 8000;
  assert_false(r._make().restore(snap), 'stale snapshot rejected');
});

test('test_sensor_offline_reported_in_escalation', () => {
  const r = new Rig(); r.prime();
  r.enter();
  r.w.on_availability('inside', false);
  r.adv(1100);
  const esc = r.events.find((e) => e.event === 'escalate');
  assert_eq(
    JSON.stringify(esc.sensors_offline),
    JSON.stringify(['inside']),
    'sensors_offline includes inside',
  );
});

test('test_bad_config_rejected', () => {
  const c = { ...DEFAULTS, exit_confirm_s: 10 };
  assert_throws(() => validate(c), 'bad config should throw');
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(60)}`);
console.log(`  ${_pass + _fail} tests: ${_pass} passed, ${_fail} failed`);
if (_errors.length > 0) {
  console.log('\nFailed tests:');
  for (const e of _errors) {
    console.log(`  - ${e.name}: ${e.error}`);
  }
}
console.log(`${'='.repeat(60)}`);
process.exit(_fail > 0 ? 1 : 0);
