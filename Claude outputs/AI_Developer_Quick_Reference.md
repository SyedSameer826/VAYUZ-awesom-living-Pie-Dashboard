# Awesom Living — AI Features Developer Quick Reference

**Architecture**: Backend gathers data → builds prompt → Claude Sonnet returns text → Backend stores result.
**Ground Rules**: (1) Backend decides all facts, AI only writes sentences. (2) AI never makes changes to settings/data. (3) One AI on/off toggle per Home. (4) Correlation only — never say one thing *caused* another.

---

## Shared Source Collections (already in MongoDB)

### sleep_sessions
```json
{
  "_id": "ObjectId",
  "resident_id": "ObjectId",
  "start_time": "2026-10-14T23:12:00Z",
  "end_time": "2026-10-15T06:52:00Z",
  "platform_date": "2026-10-14",
  "status": "complete",
  "duration_minutes": 460,
  "stages": {
    "light_minutes": 210,
    "deep_minutes": 120,
    "rem_minutes": 90,
    "awake_minutes": 40
  },
  "avg_heart_rate": 64,
  "avg_respiration": 15,
  "movement_event_count": 12,
  "snoring_detected": true,
  "toss_turn_count": 8
}
```
> `platform_date` = the calendar date the person *went to bed* (a 2 AM session on Oct 15 → platform_date Oct 14).

### bp_readings
```json
{
  "_id": "ObjectId",
  "home_id": "ObjectId",
  "resident_id": "ObjectId",
  "systolic": 142,
  "diastolic": 88,
  "pulse": 72,
  "taken_at": "2026-10-15T08:30:00Z",
  "received_at": "2026-10-15T08:31:12Z",
  "mapped_at": "2026-10-15T09:00:00Z",
  "mapped_by": "account_holder_id"
}
```
> Readings arrive unclaimed. Family member claims ("maps") a reading to a Resident via the app.

### room_occupancy_state / room_occupancy_events
```json
// room_occupancy_state (current snapshot)
{ "resident_id": "ObjectId", "room_id": "ObjectId", "occupied": true, "since": "2026-10-15T20:12:00Z" }

// room_occupancy_events (log)
{ "resident_id": "ObjectId", "room_id": "ObjectId", "event": "entered", "timestamp": "2026-10-15T20:12:00Z" }
```

### alerts
```json
{
  "_id": "ObjectId",
  "resident_id": "ObjectId",
  "home_id": "ObjectId",
  "alert_type": "no_motion",
  "triggered_at": "2026-10-15T20:47:00Z",
  "resolved_at": "2026-10-15T21:05:00Z",
  "status": "resolved",
  "resolution_reason": "confirmed_concern",
  "context": { "room": "bathroom", "threshold_minutes": 30 }
}
```
> `resolution_reason`: `false_positive` | `confirmed_concern` — needed by Feature 6 (Threshold Advisor).

### room_alert_settings
```json
{ "resident_id": "ObjectId", "room_id": "ObjectId", "long_stay_threshold_minutes": 45, "no_motion_threshold_minutes": 30 }
```

### monthly_summary (pre-computed per Resident per month)
```json
{
  "resident_id": "ObjectId",
  "month": "2026-10",
  "avg_sleep_duration_minutes": 440,
  "avg_heart_rate": 65,
  "avg_respiration": 15,
  "avg_bp_systolic": 128,
  "avg_bp_diastolic": 82,
  "bp_reading_count": 6,
  "avg_movement_events": 10,
  "snoring_nights_count": 4,
  "avg_toss_turn_count": 7,
  "alert_counts_by_type": { "no_motion": 1, "long_stay": 0, "fall": 0 },
  "total_alerts": 1
}
```

### dashboard_section_views
```json
{ "account_holder_id": "ObjectId", "home_id": "ObjectId", "section": "motion_tracking", "viewed_at": "2026-10-15T21:00:00Z" }
```

---

## Feature-by-Feature Implementation

### Feature 1 — Daily Narrative
**What**: Evening card on Dashboard. One headline per Home, one sentence + status pill + stat chips per Resident.
**Source collections**: `sleep_sessions` (by platform_date), `bp_readings` (if claimed that day), `room_occupancy_state/events`, `alerts`, device status (Home-level).
**New collections**: `daily_narratives` (id, home_id, platform_date, headline, status), `resident_narratives` (id, daily_narrative_id, resident_id, narrative_text, resident_status [ok|attention], flags, stats).
**API**: Nightly cron job generates. One Claude call per Home (all Residents at once). Headline is templated (not AI). Fallback if AI fails: plain numbers — "Sleep: 7h 40m. Blood pressure: 142/88."
**Backend pre-decides**: flags[] per Resident (short_sleep, bp_out_of_range, occupancy_alert, emergency_pressed) → resident_status = attention if any flag, else ok.

### Feature 2 — Ask Abhi on Alerts
**What**: Button on every alert card. Explains this one alert + shows 30-day history pattern for same alert_type + Resident.
**Source collections**: `alerts` (filter by resident_id + alert_type, last 30 days).
**New collection**: `alert_explanations` (id, alert_id, explanation, historical_analysis, overall_note, generated_at). Cached — made once per alert, reused on every view.
**API**: `POST /api/alerts/{alert_id}/explanation`
**Backend pre-computes**: total_count, most_common_time_of_day, most_common_room, trend (going_up|stable|going_down), resolved vs still_open counts. AI gets these aggregated numbers, never raw alert list.
**Response**: `{ "status": "ready", "explanation": "...", "historical_analysis": "...", "overall_note": "...", "stats": { "count_last_30_days": 4, "most_common_time": "8 to 9 PM", "trend": "stable" } }`
**Fallback**: Show plain stats with retry button for AI text.

### Feature 3 — Ask Abhi Chatbot
**What**: FAB button on Dashboard → chat screen. User asks free-text questions about their Residents/Homes.
**Source collections**: All of the above — accessed via a **fixed tool list** (AI picks which tool + params, Backend executes the safe query):

| Tool | Reads From | Parameters |
|---|---|---|
| get_sleep_summary | sleep_sessions | resident_id, start_date, end_date |
| get_bp_readings | bp_readings | resident_id, start_date, end_date |
| get_occupancy_summary | room_occupancy_state/events | resident_id, room (optional), start_date, end_date |
| get_door_window_events | door/window event list | home_id, device_name (optional), start_date, end_date |
| get_alerts | alerts | resident_id or home_id, alert_type (optional), start_date, end_date |

**New collection**: `conversations` (chat history per Home).
**API**: `POST /api/homes/{home_id}/chat` — request: `{ "message": "...", "conversation_id": "..." }`, response: `{ "status": "answered", "reply": "...", "source_summary": "Based on 30 nights of sleep data" }`
**Security**: AI never writes DB queries directly. Backend validates resident_id/home_id ownership. Date ranges capped at 12 months.

### Feature 4 — Monthly Review & Compare Months
**What**: Two screens per Resident. Monthly Review card: headline + 4 stat tiles (sleep, resting_hr, bp, alerts) with better/same/watch classification. Compare Months: same 4 metrics across last 5 months.
**Source collection**: `monthly_summary` (pre-computed from sleep_sessions, bp_readings, alerts).
**No new collection** — monthly_summary already exists.
**API**: `GET /api/residents/{resident_id}/monthly-review?month=2026-10` and `GET /api/residents/{resident_id}/monthly-trend?metric=sleep&months=5`
**Classification rules** (Backend decides, not AI): Sleep → better if above last month or own avg, watch if clearly below. Resting HR → same if within +/-3 bpm, watch if moved a lot. BP → same if inside range, watch if outside. Alerts → better if count down, watch if up.
**Edge cases**: No BP readings → return nothing (not zero). Fewer than 5 months → return however many exist. First month → no comparison_label.

### Feature 5 — Doctor Report
**What**: Side Menu → "Generate report with Abhi." One-month PDF for a Resident, meant for their doctor.
**Source collection**: `monthly_summary` (reuse same data as Feature 4), plus `sleep_sessions` (movement/snoring/toss fields).
**New collection**: `doctor_reports` (id, resident_id, period_start, period_end, generated_at, status [generating|ready|failed], findings, pdf_url).
**API**: `POST /api/residents/{resident_id}/doctor-report`
**Backend pre-computes** ranked findings with severity scores (bp_out_of_range=3, sleep_decline=2, unresolved_alerts=3, sleep_quality_pattern=2). AI writes prose for each finding. Backend appends device disclaimer after AI finishes.
**Critical rule**: Correlation language only — "happened together" or "may be related," NEVER "caused."

### Feature 6 — Adaptive Threshold Advisor
**What**: Weekly suggestion card on Dashboard. Suggests loosening or tightening a no_motion/long_stay threshold based on real alert history.
**Source collections**: `alerts` (with resolution_reason), `room_alert_settings`.
**New collection**: `threshold_suggestions` (id, resident_id, alert_type, direction [loosen|tighten], current_threshold_minutes, suggested_threshold_minutes, supporting_incident_ids, status [pending|dismissed|applied], generated_at).
**Trigger rules**: Loosen → 5+ false_positive alerts grouped above current setting, none confirmed_concern. Tighten → 2+ confirmed_concern alerts where time-before-confirm < current setting.
**Runs**: Once a week. Never triggered by a single alert closing.
**Prerequisite**: `alerts.resolution_reason` field must exist (not empty) — build this first.

### Feature 7 — Personalised Insight Feed
**What**: Suggests reordering Dashboard sections based on which detail pages the Account Holder actually opens most.
**Source collection**: `dashboard_section_views` (last 7 days, sorted by count).
**New collection**: `dashboard_suggestions` (id, account_holder_id, home_id, proposed_order, supporting_counts, status [pending|dismissed|applied], generated_at).
**Trigger rule**: top_section by view count is NOT already first in saved order AND top_section.count >= 2× second_section.count.
**Prerequisite**: Customise Dashboard must support opening with a suggested (unsaved) starting order.

### Feature 8 — Ask Abhi on Graphs
**What**: Button on every graph in the app. Explains that one graph in plain words and flags anything noteworthy.
**Source collections**: Depends on graph type — `sleep_sessions` (sleep_stage_timeline), `bp_readings` (bp_trend), `monthly_summary` (monthly_metric_trend).
**New collection**: `graph_explanations` (id, graph_type, resident_id, context_hash, simple_explanation, flag_text, generated_at). Cached by context_hash — same night reuses saved answer.
**API**: `POST /api/graphs/explanation` — request: `{ "graph_type": "sleep_stage_timeline", "resident_id": "...", "context": { "date": "2026-10-14" } }`, response: `{ "simple_explanation": "Rishabh spent most of the night in light sleep...", "flag_text": "Total deep sleep tonight was about 65 minutes, lower than his usual 90...", "flags": [{ "type": "low_deep_sleep" }] }`
**Unified analysis shape** — one backend function per graph_type returns: summary_stats, baseline_comparison, is_significant, flags. AI called identically regardless of graph type.

---

## Prerequisites — Build Before Any Feature

| # | What | Blocks | Build |
|---|---|---|---|
| 1 | AI on/off toggle per Home | ALL 8 features | One toggle in Home settings. When off: data cards show numbers only, "Ask Abhi" buttons hidden |
| 2 | alerts.resolution_reason | Feature 6, Feature 2 | When closing an alert: save false_positive or confirmed_concern. Cannot be empty |
| 3 | sleep_sessions movement/snoring/toss fields | Feature 5, Feature 8 | Verify GLK actually sends these fields and confirm data types |
| 4 | Customise Dashboard suggested-order support | Feature 7 | Customise Dashboard must open with a proposed order that hasn't been saved yet |
| 5 | General door/window event list | Feature 3 | A log of gate opens/closes separate from occupancy detection |
| 6 | Single alerts table migration | Feature 2, Feature 6 | If any alert type still writes to a separate table, migrate to unified alerts collection |

---

## New API Endpoints Summary

| Endpoint | Method | Feature |
|---|---|---|
| /api/alerts/{alert_id}/explanation | POST | 2: Ask Abhi on Alerts |
| /api/homes/{home_id}/chat | POST | 3: Chatbot |
| /api/homes/{home_id}/chat/recent | GET | 3: Chatbot |
| /api/residents/{resident_id}/monthly-review | GET | 4: Monthly Review |
| /api/residents/{resident_id}/monthly-trend | GET | 4: Compare Months |
| /api/residents/{resident_id}/doctor-report | POST | 5: Doctor Report |
| /api/graphs/explanation | POST | 8: Graphs |

## New Collections Summary

| Collection | Feature | Purpose |
|---|---|---|
| daily_narratives | 1 | One per Home per evening |
| resident_narratives | 1 | Per-Resident narrative under daily_narratives |
| alert_explanations | 2 | Cached explanation per alert |
| conversations | 3 | Chat history per Home |
| doctor_reports | 5 | Generated reports with PDF links |
| threshold_suggestions | 6 | Pending/dismissed/applied suggestions |
| dashboard_suggestions | 7 | Dashboard reorder suggestions |
| graph_explanations | 8 | Cached graph explanations |
