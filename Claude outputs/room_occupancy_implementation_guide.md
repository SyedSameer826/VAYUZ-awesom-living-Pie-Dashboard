# Room Occupancy Detection — Implementation Guide

**For:** App Developer (Frontend) + Backend Team  
**Spec version:** Room Occupancy Detection Logic Spec v1.1  
**Date:** Sep 10, 2026  
**Status:** Sensors verified and streaming — ready to build

---

## 1. Sensor-to-Role Mapping (Pilot Home)

The three physical sensors and what they do in the occupancy logic:

| Physical Device | Zigbee Name | Role in Logic | What It Detects |
|---|---|---|---|
| Door/Window Sensor | `window Sensor 1` | **Door sensor** | Door open/close state changes (`contact: true` = closed, `contact: false` = open) |
| Motion Sensor 2 | `motion_2 Sensor 1` | **Threshold sensor** | Doorway crossing — mounted above the door, physically masked to a narrow slit so it only fires when someone passes directly underneath |
| Motion Sensor 1 | `Motion Sensor 1` | **Room sensor** | General room activity — mounted inside the room with normal field of view, tracks ongoing movement |

**Important:** The Presence Detector is NOT used in this logic. It false-triggers on ceiling fans and exhaust fans. This is a deliberate exclusion — do not re-introduce it.

**How to read the sensor events from the backend:**

Each sensor sends events to the backend via the mqtt-bridge at `POST /api/device-event`. The backend receives:

```json
// Door sensor event
{
  "device_name": "window Sensor 1",
  "type": "contact",
  "contact": true,        // true = CLOSED, false = OPEN
  "battery": 100,
  "tamper": true
}

// Motion sensor event (both threshold and room)
{
  "device_name": "Motion Sensor 1",   // or "motion_2 Sensor 1"
  "type": "motion",
  "occupancy": true,      // true = motion detected, false = no motion
  "battery": 100,
  "illumination": "bright"
}
```

---

## 2. Occupancy States — Three States, Not Two

The current backend uses a simple boolean (`occupied: true/false`). The new logic uses three states:

| State | Meaning | How It's Entered |
|---|---|---|
| **VACANT** | No one in the room | Confirmed after EXIT_PENDING timer expires with no motion |
| **OCCUPIED** | Someone confirmed inside | Door opened+closed + threshold motion + room motion all agree |
| **EXIT_PENDING** | Someone may have left — confirming | Door opened+closed + threshold motion while OCCUPIED, but waiting to be sure |

### Entry — immediate (eager)

All three signals must agree. The moment they do, room becomes OCCUPIED with no waiting period:

```
VACANT → OCCUPIED when:
  1. Door opened AND closed (contact sensor)
  2. Threshold sensor detected crossing (motion_2)
  3. Room sensor detected activity inside (Motion Sensor 1)
```

### Possible Exit — candidate, not conclusion

```
OCCUPIED → EXIT_PENDING when:
  1. Door opened AND closed (contact sensor)
  2. Threshold sensor detected crossing (motion_2)
  → Start confirmation timer
```

### Confirming or Cancelling Exit

```
EXIT_PENDING → OCCUPIED if:
  Any motion detected (room OR threshold) before timer expires
  → Cancel timer, stay occupied

EXIT_PENDING → VACANT if:
  Confirmation timer expires with ZERO motion in both zones
  → Room is empty
```

**Design principle:** Eager to mark Occupied (safety), cautious to mark Vacant (prevent false clearance).

---

## 3. Fallback Rules

### If threshold sensor misses the crossing (slow walker, walker/cane user):

**Entry fallback:**
```
VACANT + door opened+closed + NO threshold motion:
  Wait up to N seconds (30-60s, configurable)
  If room motion detected within that window → OCCUPIED (via fallback)
```

**Exit fallback:**
```
OCCUPIED + door opened+closed + NO threshold motion:
  → EXIT_PENDING with a LONGER confirmation window than normal
  (weaker evidence = more cautious confirmation)
```

### If door is propped open:

Door sensor won't fire again while already open. Fall back to threshold sensor alone:

```
Door already OPEN (no new event) + threshold motion:
  If VACANT → OCCUPIED
  If OCCUPIED → EXIT_PENDING (still goes through confirmation)
```

---

## 4. Backend Changes Required

### 4.1 New Data Model

**`room_occupancy_events`** — raw sensor log (keep for debugging and tuning):

```
id
resident_id
room_id
event_type          -- door_open | door_close | threshold_motion | room_motion
timestamp
raw_source          -- which physical sensor reported this (device_name)
```

**`room_occupancy_state`** — derived state (what the app queries):

```
resident_id
room_id
current_state                -- vacant | occupied | exit_pending
occupied_since               -- when the current occupancy session started
exit_pending_since           -- when the confirmation window started
confirmation_deadline        -- exit_pending_since + confirmation window length
last_room_motion_at          -- last time room sensor (Motion Sensor 1) fired
last_threshold_motion_at     -- last time threshold sensor (motion_2) fired
last_door_event_at           -- last time door sensor fired
```

**`room_alert_settings`** — per-room thresholds:

```
resident_id
room_id
long_stay_threshold_minutes       -- custom minute value (no presets)
no_motion_threshold_minutes       -- custom minute value (no presets)
```

### 4.2 Sensor Role Configuration

The backend needs a mapping from physical device names to logical roles. Suggest adding to the room/home configuration:

```json
{
  "room_id": "bathroom_1",
  "room_name": "Bathroom",
  "sensors": {
    "door": "window Sensor 1",
    "threshold": "motion_2 Sensor 1",
    "room": "Motion Sensor 1"
  }
}
```

When the backend receives a `device-event`, it checks which room this device belongs to and what role it plays, then feeds it into the state machine.

### 4.3 Updated API Endpoints

**Replace** the existing bathroom status endpoint with the new occupancy endpoint:

```
GET /api/room-occupancy/status/:parentId/:roomId

Response:
{
  "room_id": "bathroom_1",
  "room_name": "Bathroom",
  "current_state": "occupied",          // "vacant" | "occupied" | "exit_pending"
  "occupied_since": "2026-09-10T10:23:00Z",
  "duration_minutes": 12,
  "visits_today": 3,
  "last_room_motion_at": "2026-09-10T10:34:00Z",
  "last_door_event_at": "2026-09-10T10:23:00Z",
  "alerts": {
    "long_stay_active": false,
    "no_motion_active": false,
    "occupancy_unconfirmed_active": false
  },
  "sensor_status": {
    "door": { "device_name": "window Sensor 1", "state": "closed", "battery": 100 },
    "threshold": { "device_name": "motion_2 Sensor 1", "last_motion": "2026-09-10T10:23:05Z", "battery": 100 },
    "room": { "device_name": "Motion Sensor 1", "last_motion": "2026-09-10T10:34:00Z", "battery": 100 }
  }
}
```

**Alert threshold configuration:**

```
GET /api/room-occupancy/settings/:parentId/:roomId

Response:
{
  "room_id": "bathroom_1",
  "long_stay_threshold_minutes": 30,
  "no_motion_threshold_minutes": 15
}

PUT /api/room-occupancy/settings/:parentId/:roomId

Body:
{
  "long_stay_threshold_minutes": 45,
  "no_motion_threshold_minutes": 20
}
```

**Occupancy event timeline (for the detail page chart):**

```
GET /api/room-occupancy/timeline/:parentId/:roomId?date=2026-09-10

Response:
{
  "sessions": [
    {
      "entered_at": "2026-09-10T06:15:00Z",
      "exited_at": "2026-09-10T06:28:00Z",
      "duration_minutes": 13,
      "entry_method": "normal",          // "normal" | "fallback"
      "alerts_fired": []
    },
    {
      "entered_at": "2026-09-10T10:23:00Z",
      "exited_at": null,                 // still occupied
      "duration_minutes": 12,
      "entry_method": "normal",
      "alerts_fired": ["long_stay"]
    }
  ],
  "total_visits": 2,
  "total_time_minutes": 25
}
```

---

## 5. Alert Types — Three Distinct Alerts

### 5.1 Long Stay Alert

Fires once per occupancy session when room has been OCCUPIED longer than the threshold, regardless of motion.

```
Trigger: (now - occupied_since) > long_stay_threshold_minutes
Condition: room_state == OCCUPIED or EXIT_PENDING
Fires: Once per session (resets when room goes VACANT)
```

**Push notification:**
- Title: `Long stay alert`
- Body: `[Resident name] has been in the [room name] for over [X] minutes.`
- Opens: Room Sensor Detail Screen

### 5.2 Motion Not Detected Alert

Fires once per occupancy session when no room motion detected for longer than the threshold, while still OCCUPIED.

```
Trigger: (now - last_room_motion_at) > no_motion_threshold_minutes
Condition: room_state == OCCUPIED or EXIT_PENDING
Fires: Once per session (resets when room goes VACANT)
```

**Push notification:**
- Title: `No motion detected`
- Body: `No movement has been detected from [Resident name] in the [room name] for over [X] minutes.`
- Opens: Room Sensor Detail Screen

### 5.3 Occupancy Unconfirmed Alert (Safety Ceiling)

Fires when OCCUPIED has persisted with zero motion AND zero door activity for longer than the safety ceiling. This is a distinct alert from "no motion" — it means the system genuinely doesn't know if the person is still there or if an exit was missed.

```
Trigger: time_since_last_motion > SAFETY_CEILING
     AND time_since_last_door_event > SAFETY_CEILING
Condition: room_state == OCCUPIED
Fires: Once (product decision on exact ceiling — e.g. 2-3 hours)
```

**Push notification:**
- Title: `Please check in`
- Body: `We haven't been able to confirm [Resident name]'s status in the [room name] for a while. Please check on them when you can.`
- Opens: Room Sensor Detail Screen

---

## 6. App UI Changes Required

### 6.1 Room Sensor Dashboard Card

Current card shows: Occupied/Vacant + time inside + visits + activity bars.

**Update the state display to show three states:**

| State | Display | Color |
|---|---|---|
| VACANT | "Vacant" | Grey/neutral |
| OCCUPIED | "Occupied" | Green (primary) |
| EXIT_PENDING | "Checking..." | Amber/yellow (transitional) |

EXIT_PENDING should feel like a brief transitional state to the user — not alarming, just "the system is confirming."

**Card data points:**
- Current state (with color)
- Time inside (if OCCUPIED or EXIT_PENDING): `"12 min"`
- Visits today: `"3 visits"`
- Last motion: relative time `"2 min ago"`

### 6.2 Room Sensor Detail Screen (`BathroomSafetyScreen.js`)

**Replace the current preset time selector** (15/30/45 min, 1hr, 2hr) **with two separate custom time inputs:**

**Long Stay Alert section:**
- Label: `"Alert me if occupied for longer than ___ minutes"`
- Single number input field (no preset buttons)
- Min/max validation (suggest: min 5, max 480)
- Save button

**Motion Not Detected Alert section:**
- Label: `"Alert me if no motion is detected for longer than ___ minutes"`
- Single number input field (no preset buttons)
- Min/max validation (suggest: min 5, max 240)
- Save button

**Both are independent and per-room.** If a home has multiple monitored rooms (bathroom, bedroom), each gets its own pair of thresholds.

**Occupancy timeline section:**
- 24h timeline bar showing occupancy sessions (colored blocks for occupied periods)
- Each block shows: entry time, exit time, duration
- Sessions where alerts fired should be visually marked (red border or icon)

**Sensor health section:**
- Show all three sensors with: name, role, battery level, last event time
- Battery low warning if any sensor < 20%

### 6.3 Notification Deep Links

Update `AppNavigator.js` notification handling to support the new event types:

| Event Type | Opens Screen |
|---|---|
| `long_stay` | Room Sensor Detail (replace `long_bathroom`) |
| `motion_not_detected` | Room Sensor Detail (new) |
| `occupancy_unconfirmed` | Room Sensor Detail (new) |

The old `long_bathroom` event type should still be handled as a fallback but route to the same screen.

---

## 7. Polling and Real-Time

The dashboard currently polls `GET /api/home-status/:parentId` every 30 seconds. The room occupancy status should be included in this polling response so the dashboard card updates.

Add to the home-status response:

```json
{
  "room_occupancy": {
    "bathroom_1": {
      "current_state": "occupied",
      "duration_minutes": 12,
      "visits_today": 3,
      "last_room_motion_at": "2026-09-10T10:34:00Z",
      "alerts": {
        "long_stay_active": false,
        "no_motion_active": false,
        "occupancy_unconfirmed_active": false
      }
    }
  }
}
```

---

## 8. Open Questions (Need Answers Before Building)

These are from the spec — they need product/testing decisions:

| # | Question | Who Decides | Default Suggestion |
|---|---|---|---|
| 1 | EXIT_PENDING confirmation window length | Test with hardware | Start with 120 seconds |
| 2 | Entry fallback window (door+no threshold) | Test with hardware | Start with 45 seconds |
| 3 | Exit fallback window (door+no threshold, longer) | Test with hardware | Start with 180 seconds |
| 4 | Safety ceiling for occupancy_unconfirmed | Product decision | Start with 3 hours |
| 5 | Min/max for custom alert time inputs | Product decision | Min 5 min, max 480 min |
| 6 | Default long_stay_threshold for new rooms | Product decision | 30 minutes |
| 7 | Default no_motion_threshold for new rooms | Product decision | 15 minutes |

These should be configurable on the backend so they can be tuned without app updates.

---

## 9. Implementation Order

### Phase 1 — Backend (build first)
1. Create data model (room_occupancy_events, room_occupancy_state, room_alert_settings)
2. Add sensor-to-role mapping configuration
3. Build the three-state machine with event correlation
4. Add confirmation timers (EXIT_PENDING → VACANT)
5. Add fallback rules (missed threshold crossing)
6. Add the three alert types with push notifications
7. Expose new API endpoints (status, settings, timeline)
8. Add room_occupancy to home-status polling response

### Phase 2 — App (after backend APIs are ready)
1. Update Room Sensor dashboard card for three states
2. Replace preset time selector with two custom time inputs
3. Add occupancy timeline to detail screen
4. Add sensor health section to detail screen
5. Update notification deep links for new event types
6. Test end-to-end with live sensors

---

## 10. Testing Checklist

After both backend and app are updated, verify these scenarios at the pilot home:

- [ ] Walk into room (door open → cross threshold → move inside) → should show OCCUPIED
- [ ] Walk out of room (door open → cross threshold → wait) → should show EXIT_PENDING then VACANT
- [ ] Walk in slowly (door open → threshold misses → room motion picks up) → should show OCCUPIED via fallback
- [ ] Prop door open, walk in (no door event, just threshold motion) → should show OCCUPIED
- [ ] Stay in room past long_stay_threshold → push notification fires
- [ ] Stop moving past no_motion_threshold → push notification fires
- [ ] Both alerts fire independently in same session
- [ ] Neither alert fires again in same session (no repeat flooding)
- [ ] EXIT_PENDING cancelled by any motion → back to OCCUPIED
- [ ] App shows correct state, duration, visits on dashboard card
- [ ] App shows occupancy timeline on detail screen
- [ ] Custom time inputs save and persist correctly
- [ ] All three sensor batteries visible on detail screen
