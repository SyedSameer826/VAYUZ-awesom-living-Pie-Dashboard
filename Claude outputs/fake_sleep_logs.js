// ============================================================
// Fake GLK sleep data — paste into MongoDB Compass mongosh
// Database: awesomliving_qa  |  Collection: emfit_logs
//
// Night 1 (yesterday):  Sep 5, 02:00 AM → 09:30 AM IST
// Night 2 (tonight):    Sep 6, 01:00 AM → 08:30 AM IST
//
// Serial: 332014813081  (GLK Vital Tracker)
// Interval: every 2 minutes (~225 docs/night, ~450 total)
// ============================================================

const SERIAL = "332014813081";

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Sleep stage cycle pattern (repeats ~every 90 min)
// Each entry: [stage, duration_min, hr_min, hr_max, rr_min, rr_max, mov_min, mov_max]
const CYCLE = [
  ["light",  20,  60, 68,  14, 16,   5, 15],
  ["deep",   30,  52, 58,  12, 14,   0,  5],
  ["light",  15,  60, 66,  14, 16,   5, 15],
  ["rem",    25,  64, 72,  15, 18,  10, 25],
];

// Build stage timeline for a given duration (minutes)
function build_timeline(total_min) {
  const timeline = [];
  let elapsed = 0;
  let cycle_idx = 0;

  while (elapsed < total_min) {
    const entry = CYCLE[cycle_idx % CYCLE.length];
    const [stage, dur, hr_lo, hr_hi, rr_lo, rr_hi, mv_lo, mv_hi] = entry;

    // Later cycles: more REM, less deep (realistic)
    let actual_dur = dur;
    if (cycle_idx >= 4 && stage === "deep") actual_dur = Math.max(15, dur - 10);
    if (cycle_idx >= 4 && stage === "rem")  actual_dur = dur + 10;

    const end = Math.min(elapsed + actual_dur, total_min);

    timeline.push({
      start: elapsed,
      end: end,
      stage,
      hr_lo, hr_hi,
      rr_lo, rr_hi,
      mv_lo, mv_hi,
    });

    elapsed = end;
    cycle_idx++;
  }

  // Last 15 min: transition to awake
  if (timeline.length > 0) {
    const last = timeline[timeline.length - 1];
    if (last.end - last.start > 15) {
      last.end -= 15;
      timeline.push({
        start: last.end,
        end: last.end + 15,
        stage: "light",
        hr_lo: 65, hr_hi: 75,
        rr_lo: 15, rr_hi: 18,
        mv_lo: 20, mv_hi: 40,
      });
    }
  }

  return timeline;
}

function get_stage_at(timeline, minute) {
  for (const seg of timeline) {
    if (minute >= seg.start && minute < seg.end) return seg;
  }
  return timeline[timeline.length - 1];
}

// Generate docs for one night
function generate_night(start_ist, duration_min, timeline) {
  const docs = [];
  const interval_min = 2;
  // IST to UTC: subtract 5h30m
  const ist_offset_ms = (5 * 60 + 30) * 60 * 1000;

  for (let m = 0; m < duration_min; m += interval_min) {
    const ist_ms = start_ist.getTime() + m * 60 * 1000;
    const utc_ms = ist_ms - ist_offset_ms;
    const ts = new Date(utc_ms);

    const seg = get_stage_at(timeline, m);
    const hr = rand(seg.hr_lo, seg.hr_hi);
    const rr = rand(seg.rr_lo, seg.rr_hi);
    const mv = rand(seg.mv_lo, seg.mv_hi);
    const is_last_5 = m >= duration_min - 5;
    const in_bed = !is_last_5;

    // Map GLK sleep stage to glk_sleep_stage field values
    const glk_stage_map = {
      deep: "deep",
      light: "light",
      rem: "rem",
      awake: "awake",
    };

    // Map to emfit-compatible sleep_stage
    const emfit_stage = in_bed ? "sleeping" : "awake";

    // Snoring: occasional during deep sleep (~20% chance)
    const snoring = seg.stage === "deep" && Math.random() < 0.2;

    // 30-second dedup bucket
    const time_bucket = Math.floor(utc_ms / 30000);

    docs.push({
      serialnumber: SERIAL,
      date_occurred: ts.toISOString(),
      in_bed: in_bed,
      restless: mv > 100,
      fast_movement: null,
      sitting_in_bed: null,
      intention_to_leave_bed: !in_bed,
      heart_rate: String(hr),
      respiration_rate: String(rr),
      activity: mv,
      ii_heart_beat: null,
      snoring: snoring,
      breathing_disturbance: null,
      tossnturn: mv > 100,
      turning_reminder: null,
      movement_in_room: null,
      may_have_fallen_from_bed: null,
      too_long_sitting: null,
      sleep_stage: emfit_stage,
      too_long_staying_in_bed: null,
      // GLK v24 fields
      apnea_suspected: false,
      life_abnormality: false,
      battery_level: rand(75, 95),
      signal_quality: rand(80, 99),
      body_movement: mv,
      glk_status: in_bed ? (seg.stage === "deep" ? "in_bed" : "in_bed") : "out_of_bed",
      out_of_bed: !in_bed,
      glk_sleep_stage: in_bed ? glk_stage_map[seg.stage] : "awake",
      data_type: "sleep_stage",
      time_bucket: time_bucket,
      createdAt: ts,
      updatedAt: ts,
    });
  }

  return docs;
}

// ── Night 1: Yesterday (Sep 5) 02:00 AM → 09:30 AM IST ──
const night1_start = new Date("2026-09-05T02:00:00");  // IST (local)
const night1_duration = 7.5 * 60;  // 450 minutes
const night1_timeline = build_timeline(night1_duration);
const night1_docs = generate_night(night1_start, night1_duration, night1_timeline);

// ── Night 2: Tonight (Sep 6) 01:00 AM → 08:30 AM IST ──
const night2_start = new Date("2026-09-06T01:00:00");  // IST (local)
const night2_duration = 7.5 * 60;  // 450 minutes
const night2_timeline = build_timeline(night2_duration);
const night2_docs = generate_night(night2_start, night2_duration, night2_timeline);

const all_docs = [...night1_docs, ...night2_docs];

print(`\nGenerating ${all_docs.length} fake sleep logs ...`);
print(`  Night 1 (Sep 5): ${night1_docs.length} docs, 02:00-09:30 AM IST`);
print(`  Night 2 (Sep 6): ${night2_docs.length} docs, 01:00-08:30 AM IST`);

const result = db.emfit_logs.insertMany(all_docs, { ordered: false });

print(`\nInserted: ${result.insertedCount} documents`);
print("Done!");
