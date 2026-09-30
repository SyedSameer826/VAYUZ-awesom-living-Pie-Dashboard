/**
 * Acceptance suite for Specification v4.0 (two sensors, no door contact) — run: node --test
 * Fake clock, no MQTT, no DB, no network. Every case maps to spec section 8.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { BathroomOccupancy, ROLES, STATES } = require('./occupancyStateMachine.cjs');

const DAY = Date.UTC(2026, 8, 27, 8, 30);    // 14:00 IST
const NIGHT = Date.UTC(2026, 8, 27, 17, 30); // 23:00 IST

class Rig {
  constructor(cfg = {}, start = DAY) {
    this.t = start;
    this.events = [];
    this.sm = new BathroomOccupancy(cfg, e => this.events.push(e));
    this.prime();
  }
  prime() { // idle values first; they are record-only by design
    for (const r of [ROLES.DOORWAY, ROLES.INSIDE]) this.sm.onSensor(r, false, this.t);
  }
  adv(sec, step = 1) {
    const end = this.t + sec * 1000;
    while (this.t < end) { this.t = Math.min(end, this.t + step * 1000); this.sm.tick(this.t); }
  }
  set(role, v) { this.sm.onSensor(role, v, this.t); this.sm.tick(this.t); }
  pir(role, dur = 5) { this.set(role, true); this.adv(dur); this.set(role, false); }
  enter() { this.pir(ROLES.DOORWAY); this.adv(2); this.pir(ROLES.INSIDE); }
  names() { return this.events.map(e => e.type); }
  last(type) { return [...this.events].reverse().find(e => e.type === type); }
  family() { return this.events.filter(e => e.audience === 'family'); }
}

// ---------------------------------------------------------------- spec 8.1
test('still person: two chimes then a family alert', () => {
  const r = new Rig();
  r.enter();
  assert.equal(r.sm.state, STATES.OCCUPIED);
  r.adv(900);
  assert.equal(r.sm.state, STATES.CHECKING);
  r.adv(90); assert.ok(r.names().includes('check_repeat'));
  r.adv(90);
  assert.equal(r.sm.state, STATES.ALERTED);
  const a = r.last('inactivity_alert');
  assert.equal(a.subject, 'someone');
  assert.equal(a.audience, 'family');
  assert.equal(a.critical, true);
  r.adv(300); assert.ok(r.names().includes('alert_repeat'));
});

test('normal visit in and out: no alert, no family push', () => {
  const r = new Rig();
  r.pir(ROLES.DOORWAY);
  for (let i = 0; i < 10; i++) { r.pir(ROLES.INSIDE); r.adv(20); }
  r.pir(ROLES.DOORWAY);
  r.adv(60);
  assert.equal(r.sm.state, STATES.VACANT);
  assert.ok(r.names().includes('exit'));
  assert.equal(r.family().length, 0);       // spec 5.1: no occupancy pushes
});

test('movement during the chime window resolves silently', () => {
  const r = new Rig();
  r.enter(); r.adv(905);
  assert.equal(r.sm.state, STATES.CHECKING);
  r.adv(20); r.pir(ROLES.INSIDE);
  assert.equal(r.sm.state, STATES.OCCUPIED);
  assert.ok(r.names().includes('check_resolved'));
  assert.equal(r.family().length, 0);
});

test('missed doorway entry is caught by inside motion', () => {
  const r = new Rig();
  r.pir(ROLES.INSIDE);
  assert.equal(r.sm.state, STATES.OCCUPIED);
  assert.equal(r.last('entry').confirmedBy, 'inside_only');
});

test('zigbee latency inversion on exit still empties', () => {
  const r = new Rig();
  r.enter(); r.adv(30);
  r.set(ROLES.DOORWAY, true); r.adv(2);
  r.set(ROLES.INSIDE, true); r.adv(3); r.set(ROLES.INSIDE, false);
  r.set(ROLES.DOORWAY, false);
  r.adv(60);
  assert.equal(r.sm.state, STATES.VACANT);
});

test('second person enters: room stays occupied', () => {
  const r = new Rig();
  r.enter(); r.adv(60);
  r.pir(ROLES.DOORWAY); r.adv(8); r.pir(ROLES.INSIDE);
  assert.equal(r.sm.state, STATES.OCCUPIED);
  r.adv(60);
  assert.equal(r.sm.state, STATES.OCCUPIED);
});

test('quick in and out without stepping in clears silently', () => {
  const r = new Rig();
  r.set(ROLES.DOORWAY, true); r.adv(5); r.set(ROLES.DOORWAY, false);
  r.adv(70);
  assert.equal(r.sm.state, STATES.VACANT);
  assert.ok(r.names().includes('entry_unconfirmed'));
  assert.equal(r.family().length, 0);
});

test('night threshold is shorter', () => {
  const r = new Rig({}, NIGHT);
  r.enter(); r.adv(605);
  assert.equal(r.sm.state, STATES.CHECKING);
});

test('no chime configured escalates directly', () => {
  const r = new Rig({ chimeEnabled: false });
  r.enter(); r.adv(905);
  assert.equal(r.sm.state, STATES.ALERTED);
});

test('retained and first-seen messages never trigger', () => {
  const r = new Rig();
  r.sm.onSensor(ROLES.DOORWAY, true, r.t, { retained: true });
  assert.equal(r.sm.state, STATES.VACANT);
});

test('repeated true reports are not new edges', () => {
  const r = new Rig();
  r.set(ROLES.DOORWAY, true);
  r.set(ROLES.DOORWAY, true);            // battery report carrying cached occupancy
  assert.equal(r.names().filter(n => n === 'entry_tentative').length, 1);
});

test('restore after a power cut keeps the visit and the silence', () => {
  const r = new Rig();
  r.enter(); r.adv(300);
  const snap = r.sm.snapshot(r.t);
  r.t += 400 * 1000;                     // outage
  const sm2 = new BathroomOccupancy({}, e => r.events.push(e));
  assert.equal(sm2.restore(snap, r.t), true);
  r.sm = sm2;
  assert.equal(sm2.state, STATES.OCCUPIED);
  r.adv(210);
  assert.equal(sm2.state, STATES.CHECKING);   // outage counted toward silence
});

test('stale snapshot is refused', () => {
  const r = new Rig();
  r.enter();
  const snap = r.sm.snapshot(r.t);
  const sm2 = new BathroomOccupancy({}, () => {});
  assert.equal(sm2.restore(snap, r.t + 8000 * 1000), false);
});

test('bad config is rejected', () => {
  assert.throws(() => new BathroomOccupancy({ exitConfirmS: 10 }, () => {}));
  assert.throws(() => new BathroomOccupancy({ silenceDayS: 60 }, () => {}));
  assert.throws(() => new BathroomOccupancy({ longStayS: [100, 50, 20] }, () => {}));
});

// ---------------------------------------------------------------- spec 8.2
test('B7 twelve-minute toilet visit: no alert', () => {
  const r = new Rig();
  r.enter();
  r.adv(720);
  assert.equal(r.sm.state, STATES.OCCUPIED);
  assert.equal(r.family().length, 0);
});

test('B8 35-minute shower with movement: no inactivity alert, no long stay yet', () => {
  const r = new Rig();
  r.enter();
  for (let i = 0; i < 35; i++) { r.adv(55); r.pir(ROLES.INSIDE); }
  assert.equal(r.sm.state, STATES.OCCUPIED);
  assert.equal(r.names().includes('inactivity_alert'), false);
  assert.equal(r.names().includes('long_stay'), false);
  r.adv(600);                                  // past 45 min total
  assert.equal(r.last('long_stay').level, 1);
});

test('B9/B10 alert then movement: automatic all-clear to the family', () => {
  const r = new Rig();
  r.enter(); r.adv(905 + 190);
  assert.equal(r.sm.state, STATES.ALERTED);
  r.pir(ROLES.INSIDE);
  const ac = r.last('all_clear');
  assert.ok(ac);
  assert.equal(ac.audience, 'family');
  assert.equal(r.sm.state, STATES.OCCUPIED);
});

test('B11 acknowledgement stops the repeats', () => {
  const r = new Rig();
  r.enter(); r.adv(905 + 190);
  assert.equal(r.sm.acknowledge(r.t, 'user-1'), true);
  r.adv(600);
  assert.equal(r.names().filter(n => n === 'alert_repeat').length, 0);
});

test('B16 inside sensor dies mid-visit: degraded, ops told, no false alert', () => {
  const r = new Rig();
  r.enter(); r.adv(60);
  r.sm.onAvailability(ROLES.INSIDE, false, r.t);
  r.adv(1200);
  assert.equal(r.sm.state, STATES.DEGRADED);
  assert.equal(r.last('monitoring_degraded').audience, 'ops');
  assert.equal(r.names().includes('inactivity_alert'), false);
  r.sm.onAvailability(ROLES.INSIDE, true, r.t);
  assert.equal(r.sm.state, STATES.OCCUPIED);
});

test('B18 long stay counts across midnight', () => {
  const r = new Rig({}, Date.UTC(2026, 8, 27, 18, 20)); // 23:50 IST
  r.enter();
  r.adv(2800);                                  // crosses midnight
  assert.equal(r.last('long_stay').level, 1);
});

test('B19 test mode expires by itself', () => {
  const r = new Rig({ testMode: true });
  assert.equal(r.sm.cfg.silenceDayS, 60);
  r.adv(1900, 10);
  assert.ok(r.names().includes('test_mode_expired'));
  assert.equal(r.sm.cfg.silenceDayS, 900);
});

test('exit restarts are capped', () => {
  const r = new Rig();
  r.enter(); r.adv(30);
  r.pir(ROLES.DOORWAY);
  for (let i = 0; i < 6; i++) { r.adv(20); r.pir(ROLES.DOORWAY); }
  r.adv(60);
  assert.equal(r.sm.state, STATES.VACANT);
});

test('away mode pauses everything and is never inferred', () => {
  const r = new Rig();
  r.sm.setAway(true, r.t);
  r.pir(ROLES.DOORWAY); r.pir(ROLES.INSIDE);
  r.adv(2000);
  assert.equal(r.sm.state, STATES.AWAY);
  assert.equal(r.family().length, 0);
  r.sm.setAway(false, r.t);
  r.pir(ROLES.INSIDE);
  assert.equal(r.sm.state, STATES.OCCUPIED);
});

// ------------------------------------------------- v4: two-sensor cases
test('C1 someone looks in from the doorway and walks away: never occupied', () => {
  const r = new Rig();
  r.pir(ROLES.DOORWAY, 8);          // lingers at the door, never steps in
  r.adv(1000);
  assert.equal(r.sm.state, STATES.VACANT);
  assert.ok(!r.names().includes('entry'));
  assert.equal(r.family().length, 0);
});

test('C2 full visit with no door sensor anywhere in the system', () => {
  const r = new Rig();
  r.enter();
  assert.equal(r.sm.state, STATES.OCCUPIED);
  for (let i = 0; i < 8; i++) { r.adv(60); r.pir(ROLES.INSIDE); }
  r.pir(ROLES.DOORWAY);
  r.adv(60);
  assert.equal(r.sm.state, STATES.VACANT);
  assert.equal(r.family().length, 0);
});

test('C3 sustained inside motion alone confirms entry', () => {
  const r = new Rig();
  r.set(ROLES.DOORWAY, true); r.adv(2); r.set(ROLES.DOORWAY, false);
  r.set(ROLES.INSIDE, true);        // walks in, stays in view
  r.adv(15);
  assert.equal(r.sm.state, STATES.OCCUPIED);
});

test('C4 exit then immediate re-entry is handled', () => {
  const r = new Rig();
  r.enter(); r.adv(60);
  r.pir(ROLES.DOORWAY);             // leaves
  r.adv(20);
  r.pir(ROLES.DOORWAY);             // comes straight back
  r.adv(6); r.pir(ROLES.INSIDE);
  assert.equal(r.sm.state, STATES.OCCUPIED);
  r.adv(905 + 190);
  assert.equal(r.sm.state, STATES.ALERTED);
});

test('C5 collapse right after a crossing: re-latched by the fall itself', () => {
  const r = new Rig();
  r.enter(); r.adv(120);
  r.pir(ROLES.DOORWAY);             // steps toward the door, then falls
  r.adv(50);
  assert.equal(r.sm.state, STATES.VACANT);   // known limitation, spec 11.1
  r.pir(ROLES.INSIDE);              // movement of the fall, or afterwards
  assert.equal(r.sm.state, STATES.OCCUPIED);
  r.adv(905 + 190);
  assert.equal(r.sm.state, STATES.ALERTED);  // and the alert still fires
});
