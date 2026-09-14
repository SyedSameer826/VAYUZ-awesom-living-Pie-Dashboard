# Room Occupancy Detection — App Developer Guide

**Date:** 2026-09-10
**Status:** Backend deployed to Production. No app changes required for core safety alerts.

---

## Summary

The backend now includes a 3-device room occupancy detection system (threshold motion sensor + room motion sensor + door/window contact sensor). It tracks whether a room is Vacant, Occupied, or Exit Pending, and fires escalating safety alerts (push notifications + alert_log entries) when something needs attention.

**No Flutter app changes are required for the core safety functionality to work.** Push notifications, alert log entries, and deep links all flow through the same existing infrastructure the app already handles. This document explains what works automatically and what optional enhancements can be added later.

---

## What Works Automatically (No App Changes)

### 1. Push Notifications

All three occupancy alert types dispatch through the same `dispatch_notification` path as every other alert in the system. The app receives them as standard FCM push notifications with the same payload structure.

| Alert | Push Title | Push Body | Screen |
|---|---|---|---|
| Long Stay (3 levels) | "Long stay alert" | "{resident} has been in the {location} for over {threshold} minutes." | `RoomSensorScreen` |
| No Motion (3 levels) | "No motion detected" | "No movement has been detected from {resident} in the {location} for over {threshold} minutes." | `RoomSensorScreen` |
| Unconfirmed (1 level) | "Please check in" | "We haven't been able to confirm {resident}'s status in the {location} for a while. Please check on them when you can." | `RoomSensorScreen` |

- `RoomSensorScreen` is already a known screen in the app (used by the existing `INACTIVITY_POSSIBLE_FALL` event, id 2).
- `deep_link` is `/timeline/{residentId}` for all three events.
- Per-level title and severity overrides are passed by the backend for Long Stay and No Motion (L1 warning, L2 critical, L3 emergency). The app does not need to know about levels — the push title and body already reflect the severity.

### 2. Alert Log Entries

Each alert creates a standard `alert_log` document with `device_type: 'zigbee'` and `device` set to one of the group's physical sensor IDs. These entries appear automatically in:

- `GET /api/user/devices/:device_id/alerts` (per-device alert history, no type filter)
- `GET /api/user/devices/:device_id/no-motion-alerts` (queries all zigbee devices in the room)

Alert levels used: `warning` (L1), `critical` (L2), `emergency` (L3).

### 3. Notification Muting

All three events are categorized under `DeviceCategory.MOTION_PRESENCE`, so the existing per-device-category mute toggle in the app applies to them automatically.

- `OCCUPANCY_NO_MOTION` is `quiet_hours_exempt: true` (fires even during quiet hours).
- `OCCUPANCY_LONG_STAY` and `OCCUPANCY_UNCONFIRMED` respect quiet hours.

---

## New Socket Events (App Ignores Safely)

The backend emits four new socket events. The app currently ignores events it has no listener for — no crashes, no errors. These are documented here for **optional** future use.

### `room_occupancy_update`

Fired on every state transition (vacant to occupied, occupied to exit_pending, etc.).

```json
{
  "occupancy_group": "bathroom_1",
  "resident": "ObjectId",
  "state": "occupied",
  "occupied_since": "2026-09-10T08:15:00.000Z",
  "exit_pending_since": null,
  "confirmation_deadline": null,
  "room_label": "Bathroom",
  "last_room_motion_at": "2026-09-10T08:14:55.000Z",
  "last_threshold_motion_at": "2026-09-10T08:14:50.000Z",
  "last_door_cycle_at": "2026-09-10T08:14:45.000Z",
  "door_is_open": false
}
```

### `occupancy_long_stay_alert`

Fired per escalation level (L1/L2/L3) when the room has been occupied too long.

```json
{
  "occupancy_group": "bathroom_1",
  "room": "Bathroom",
  "duration": "32 minutes",
  "duration_min": 32,
  "level": 1,
  "severity": "warning",
  "time": "2026-09-10T08:47:00.000Z",
  "alert_log_id": "ObjectId"
}
```

### `occupancy_no_motion_alert`

Fired per escalation level (L1/L2/L3) when no room motion is detected while occupied.

```json
{
  "occupancy_group": "bathroom_1",
  "room": "Bathroom",
  "duration": "16 minutes",
  "duration_min": 16,
  "level": 1,
  "severity": "warning",
  "time": "2026-09-10T08:31:00.000Z",
  "alert_log_id": "ObjectId"
}
```

### `occupancy_unconfirmed_alert`

Fired once when the room is stuck occupied with zero corroborating signal beyond the safety ceiling (default 4 hours).

```json
{
  "occupancy_group": "bathroom_1",
  "room": "Bathroom",
  "hours_silent": 4.2,
  "time": "2026-09-10T12:15:00.000Z",
  "alert_log_id": "ObjectId"
}
```

---

## Device Model Changes (Informational)

Two new fields were added to the Zigbee device schema. These appear in device list API responses but do not require app-side handling — the app can simply ignore unknown fields.

| Field | Type | Purpose |
|---|---|---|
| `occupancy_group` | String (nullable) | Groups 3 sensors into one room (e.g. `"bathroom_1"`) |
| `sensor_role` | String enum (nullable) | `threshold_motion`, `room_motion`, or `occupancy_door` |

---

## State Machine (Backend Only)

The backend manages a three-state machine per (resident, occupancy_group):

```
  ┌─────────┐    door cycle + motion signals    ┌──────────┐
  │  Vacant  │ ─────────────────────────────────>│ Occupied │
  └─────────┘                                    └──────────┘
       ^                                              │
       │                                              │ door cycle + threshold
       │                                              v
       │         confirmation window expires    ┌──────────────┐
       └───────────────────────────────────────│ Exit Pending  │
                                                └──────────────┘
                                                      │
                                      any motion ─────┘ (cancels exit,
                                                         back to Occupied)
```

**Entry triggers:** door cycle + threshold motion + room motion (all within entry window), OR fallback: door cycle + room motion (no threshold — slow mover), OR propped door: threshold motion alone when door is open.

**Exit triggers:** door cycle + threshold motion while occupied → exit_pending. If no motion detected during confirmation window → vacant. Any motion during exit_pending cancels it back to occupied.

This runs entirely on the backend. The app does not need to implement any state machine logic.

---

## Database Configuration Required

The three pilot sensors need `occupancy_group` and `sensor_role` set in MongoDB before the system activates. This is a one-time backend/DB task:

| Device Name | occupancy_group | sensor_role |
|---|---|---|
| window Sensor 1 | `bathroom_1` | `occupancy_door` |
| motion_2 Sensor 1 | `bathroom_1` | `threshold_motion` |
| Motion Sensor 1 | `bathroom_1` | `room_motion` |

**This is a backend-only configuration step.** No app involvement needed.

---

## Optional Future Enhancements (Not Required Now)

If the app team wants to build a richer occupancy UI later, here is what the backend supports:

### A. Real-Time Occupancy Widget
Listen for `room_occupancy_update` socket events to show a live "Vacant / Occupied / Exit Pending" badge on the room sensor card or dashboard. Show `occupied_since` as a live timer.

### B. Alert Level Indicators
Listen for `occupancy_long_stay_alert` / `occupancy_no_motion_alert` / `occupancy_unconfirmed_alert` socket events to show in-app alert badges with escalation level (L1 warning amber, L2 critical orange, L3 emergency red).

### C. Occupancy Settings Screen
The backend has a `room_occupancy_settings` model with configurable thresholds (long stay minutes per level, no motion minutes per level, safety ceiling hours, night mode toggle with separate night thresholds). An admin settings screen could be built via new API endpoints when needed.

### D. Occupancy State API
A REST endpoint to query current occupancy state per resident (for app cold-start, when socket events haven't been received yet) can be added when the UI is built. Currently the state is only pushed via socket.

---

## Summary Table

| Feature | Works Without App Changes? | Notes |
|---|---|---|
| Push notifications (3 alert types) | YES | Same FCM path, existing `RoomSensorScreen` |
| Alert log entries | YES | Shows in per-device alert history API |
| Notification muting | YES | `MOTION_PRESENCE` category, existing toggle |
| Deep link on push tap | YES | `RoomSensorScreen` already handled |
| Real-time occupancy state UI | No (optional) | Needs socket listener + UI widget |
| Alert level badges in-app | No (optional) | Needs socket listener + UI |
| Occupancy settings UI | No (optional) | Needs new API endpoints + screen |
