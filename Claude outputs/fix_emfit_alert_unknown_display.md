# Fix: "Danger — UNKNOWN" Alert Display on NRI Dashboard

## Problem

When GLK vital signs breach danger/critical thresholds, the app shows:

> **Danger — UNKNOWN, Device: 332014813081**

The alert level ("Danger") renders correctly, but the alert category shows "UNKNOWN" because the `emfit_alert` socket event carried no field identifying which vital triggered it.

## Root Cause

Backend's `start_emfit_alert_checker()` in `health_logs.js` was emitting the `emfit_alert` socket event with only `{ device, alert, vitals, time }` — no alert type identifier.

## Backend Fix (Already Applied)

The `emfit_alert` socket payload now includes two new fields:

| Field | Type | Example Value | Description |
|-------|------|---------------|-------------|
| `alert_type` | `string` | `"Elevated Heart Rate"` | Human-readable title-case label, ready to display directly |
| `backend_event` | `string` | `"GLK_ELEVATED_HEART_RATE"` | Raw event key matching the push notification catalog |

### Possible `alert_type` Values

| `alert_type` | `backend_event` | Meaning |
|---|---|---|
| `"Elevated Heart Rate"` | `GLK_ELEVATED_HEART_RATE` | HR above normal max |
| `"Low Heart Rate"` | `GLK_LOW_HEART_RATE` | HR below normal min |
| `"High Respiratory Rate"` | `GLK_HIGH_RESPIRATORY_RATE` | RR above normal max |
| `"Low Respiratory Rate"` | `GLK_LOW_RESPIRATORY_RATE` | RR below normal min |

### Updated Socket Payload Shape

```json
{
  "device": "332014813081",
  "alert": "danger",
  "alert_type": "Elevated Heart Rate",
  "backend_event": "GLK_ELEVATED_HEART_RATE",
  "vitals": {
    "heart_rate": 112,
    "respiration": 24
  },
  "time": "2026-09-15T06:45:00.000Z"
}
```

## Frontend Changes Required

### 1. Update the `emfit_alert` Socket Listener

Where the app currently listens for the `emfit_alert` event and displays the alert banner, read `alert_type` from the payload.

**Before (current behavior):**
The app shows `alert` field ("danger"/"critical") but has no category to display, so it falls back to "UNKNOWN".

**After (expected behavior):**
Display `alert_type` as the alert category label. Example rendering:

> **Danger — Elevated Heart Rate**
> Device: 332014813081

### 2. Display Logic

```
// Pseudocode for the alert banner
title = data.alert.toUpperCase()          // "DANGER" or "CRITICAL"
category = data.alert_type ?? "Vitals"    // "Elevated Heart Rate" (fallback: "Vitals")

// Render: "{title} — {category}"
// e.g.   "DANGER — Elevated Heart Rate"
```

### 3. Backward Compatibility

Use a fallback value for `alert_type` so the app handles both old and new backend versions gracefully:

```
alert_type = data.alert_type ?? "Vital Signs Alert"
```

Old backend payloads that lack `alert_type` will display "Vital Signs Alert" instead of "UNKNOWN".

### 4. No Changes Needed For

- Push notifications — these already use the notification catalog copy (e.g. "High Heart Rate", "{resident}'s heart rate has been elevated...") and are unaffected.
- `bathroom_alert` socket events — these have their own payload structure with room/duration info and are not affected by this issue.
- Alert log entries — the `alert_log` collection already stores `title: 'Vital Signs Alert'` and `description: 'Abnormal vitals — HR: X, RR: Y'`.

## Testing

1. Deploy the updated backend to QA.
2. Wait for GLK device to report vitals that breach thresholds (or temporarily lower thresholds in `config/month_name.js` for testing).
3. Verify the NRI dashboard alert banner shows the correct category label (e.g. "Danger — Elevated Heart Rate") instead of "Danger — UNKNOWN".
4. Verify push notification copy is unchanged and still reads correctly.
