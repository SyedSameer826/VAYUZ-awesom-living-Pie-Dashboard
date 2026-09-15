# Previous Sleep Session + Sleep Session Ended Flag

**Date:** 2026-09-15
**For:** Frontend App Dev
**Priority:** High

---

## Overview

Two changes to the sleep section of the app:

1. **Dashboard Detail Page (SleepScreen)** — display the previous night's sleep session times so the family can compare last night vs. the night before.
2. **Dashboard Summary API** — add a `sleep_session_ended` flag (boolean) that is `true` when the current night's sleep session has ended. The app uses this to show a "Session Complete" indicator on the dashboard card.

---

## 1. Previous Sleep Session on Detail Page (SleepScreen)

### What exists today

The backend detail API (`get_health_checker`) **already returns** a `previous_sleep_session` key in its response:

```json
{
  "sleep_start": "11:30 pm",
  "wake_time": "06:15 am",
  "last_night_sleep": { ... },
  "heart_rate": { ... },
  "snoring": { ... },
  "restless": { ... },
  "in_bed": { ... },
  "activity": { ... },
  "vitals_30min": [ ... ],
  "previous_sleep_session": {
    "sleep_start_time": "2026-09-13T23:10:00.000Z",
    "sleep_end_time": "2026-09-14T05:45:00.000Z"
  }
}
```

When there is no previous session, the value is `null`.

### What the app needs to do

**File:** `src/screens/nri/SleepScreen.js`

Display a "Previous Night" comparison row below the current sleep start/end section. No new API call is needed — the data is already in the existing response.

#### UI Spec

- **Location:** Below the current night's "Sleep Start" / "Wake Time" row, separated by a thin divider.
- **Label:** "Previous Night"
- **Layout:** Same row style as current night — two columns:
  - Left: "Slept at" + time (formatted to `hh:mm a` in IST)
  - Right: "Woke at" + time (formatted to `hh:mm a` in IST)
- **Style:** Use `#828282` (grey text) to visually de-emphasize compared to current night. Font size one step smaller than the current night values.
- **When `previous_sleep_session` is `null`:** Hide the entire "Previous Night" row — do not show an empty row or placeholder.

#### Data Mapping

```
previous_sleep_session.sleep_start_time  →  "Slept at" column (convert UTC ISO to IST hh:mm a)
previous_sleep_session.sleep_end_time    →  "Woke at" column  (convert UTC ISO to IST hh:mm a)
```

**Note:** `sleep_end_time` can be `null` if the previous session was capped (auto-closed by safety timer). In that case show a dash `—` for the "Woke at" value.

#### Example Rendering

```
┌──────────────────────────────────────┐
│  Last Night                          │
│  Slept at         Woke at            │
│  11:30 pm         06:15 am           │
│──────────────────────────────────────│
│  Previous Night                      │
│  Slept at         Woke at            │
│  11:10 pm         05:45 am           │
└──────────────────────────────────────┘
```

---

## 2. `sleep_session_ended` Flag in Dashboard Summary API

### What exists today

The dashboard summary API (`get_dashboard_summary`) already returns:

```json
{
  "is_sleeping": true,
  "sleep_start": "11:30 pm",
  "wake_time": null,
  "last_night_sleep": { ... },
  "previous_sleep_session": { ... }
}
```

- `is_sleeping` = `true` when the person is currently in bed and in a sleeping state.
- `previous_sleep_session` = the last completed session before today's platform date.

### What needs to be added

A new key `sleep_session_ended` (boolean) in the same response object. **Do not change any existing keys or object structure.**

#### Updated response shape

```json
{
  "is_sleeping": false,
  "sleep_session_ended": true,
  "sleep_start": "11:30 pm",
  "wake_time": "06:15 am",
  "last_night_sleep": { ... },
  "heart_rate": { ... },
  "activity": { ... },
  "sleep_stage_timeline": { ... },
  "snoring": { ... },
  "restless": { ... },
  "previous_sleep_session": {
    "sleep_start_time": "2026-09-13T23:10:00.000Z",
    "sleep_end_time": "2026-09-14T05:45:00.000Z"
  }
}
```

### Backend Logic

**File:** `server/service/dashboard_service.js`
**Function:** `get_dashboard_summary`

Add after the existing `is_sleeping` block (around line 2236):

```javascript
/* ---------------- SLEEP SESSION ENDED FLAG ---------------- */
// true  = a sleep session existed in tonight's window AND it has ended
//         (person woke up / left bed / session confirmed complete)
// false = no session yet, OR person is still sleeping
const sleep_session_ended = last_session !== null
  && wake_time_ts !== null
  && !is_sleeping;
```

Then add `sleep_session_ended` to the return object (after `is_sleeping`):

```javascript
return {
  is_sleeping,
  sleep_session_ended,   // ← new key
  sleep_start,
  wake_time,
  // ... rest unchanged
};
```

#### Truth Table

| `last_session` | `wake_time_ts` | `is_sleeping` | `sleep_session_ended` | Meaning |
|---|---|---|---|---|
| null | null | false | **false** | No sleep data tonight |
| exists | null | true | **false** | Currently sleeping (session in progress, no wake time yet) |
| exists | set | true | **false** | Briefly stirred but still in bed / sleeping state |
| exists | set | false | **true** | Sleep session complete — person woke up |

### Frontend Usage

**File:** `src/screens/nri/NRIDashboard.js`

The dashboard sleep card can use `sleep_session_ended` to decide what to show:

| `is_sleeping` | `sleep_session_ended` | Dashboard Card State |
|---|---|---|
| `true` | `false` | Show "Currently Sleeping" with live duration |
| `false` | `true` | Show completed sleep summary (duration, score) |
| `false` | `false` | Show "No sleep data yet" or previous session |

#### Example usage in the sleep card:

```jsx
{data.is_sleeping && (
  <Badge text="Sleeping" color="#34c759" />
)}
{data.sleep_session_ended && (
  <Badge text="Session Complete" color="#828282" />
)}
{!data.is_sleeping && !data.sleep_session_ended && (
  <Text style={{ color: '#828282' }}>No sleep data yet</Text>
)}
```

---

## Summary of Changes

| Layer | File | Change |
|---|---|---|
| Backend | `server/service/dashboard_service.js` | Add `sleep_session_ended` boolean to `get_dashboard_summary` return object |
| Frontend | `src/screens/nri/SleepScreen.js` | Display `previous_sleep_session` times below current night's sleep times |
| Frontend | `src/screens/nri/NRIDashboard.js` | Use `sleep_session_ended` flag to show session complete state on dashboard card |

### Rules

- **Do not change the existing object structure** of any API response. Only add the new `sleep_session_ended` key alongside existing keys.
- Use snake_case for all new keys and variables.
- The `previous_sleep_session` data is already returned by both APIs — no backend change needed for that part.
- Times from `previous_sleep_session` are UTC ISO strings — convert to IST `hh:mm a` format in the app before display.
