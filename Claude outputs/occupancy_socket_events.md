# Room Occupancy — Socket Events Reference

All events are emitted via `socket_service.send_to_user(user_id, event_name, payload)`.

---

## 1. `room_occupancy_update`

**When:** Every state change — entry started, entry complete (occupied), exit started, exit confirmed (vacant), entry/exit timeout, master motion toggled, door toggled.

**Frequency:** On every sensor event that changes state + on cron timeouts.

```json
{
  "occupancy_group": "Washroom",
  "resident": "664abc...",
  "state": "vacant | entry_pending | occupied | exit_pending",
  "occupied_since": "2025-09-21T10:05:00.000Z",  // null when vacant
  "room_label": "Washroom",
  "master_is_active": true,
  "door_is_open": false,
  "entry_step": 0,   // 0-3 (only meaningful when state=entry_pending)
  "exit_step": 0      // 0-4 (only meaningful when state=exit_pending)
}
```

**Frontend use:** Update the presence card UI in real time — show occupied/vacant badge, entry/exit progress indicator if desired.

---

## 2. `occupancy_long_stay_alert`

**When:** Person has been in the room for too long. Three escalating levels, then emergency repeats every 5 min (30s in test mode) until the last alert_log is acknowledged (resolved).

**Levels:**

| Level | Default Threshold | Test Threshold | Severity |
|-------|------------------|---------------|----------|
| 1 | 30 min | 3 min | `warning` |
| 2 | 35 min | 3.5 min | `critical` |
| 3 | 40 min | 4 min | `emergency` |
| 3 (repeat) | every 5 min after L3 | every 30s | `emergency` |

```json
{
  "occupancy_group": "Washroom",
  "room": "Washroom",
  "duration": "35 min",              // human-readable
  "duration_min": 35.12,             // numeric minutes
  "level": 2,                        // 1 | 2 | 3
  "severity": "critical",            // "warning" | "critical" | "emergency"
  "time": "2025-09-21T10:40:00.000Z",
  "alert_log_id": "66fabc...",
  "is_repeat": true                  // only present on L3 repeats
}
```

**Frontend use:** Show alert banner/modal with severity color coding. `alert_log_id` links to the alert_log entry for acknowledge/resolve actions. When `is_repeat` is true, it's an emergency repeat — highlight urgently. Repeats stop once the alert_log with this `alert_log_id` is marked `is_resolved: true`.

**Push notification:** `OCCUPANCY_LONG_STAY` (event id 41, P2, push enabled)

---

## 3. `occupancy_no_motion_alert`

**When:** Person is in the room (occupied state) + master sensor says no motion (`occupancy=false`) + no door or curtain activity for 1+ minute (30s in test mode). This is the "someone is in the room for too long and not moving" P0 alert.

**Fires once** per occupied session — resets when master sends `occupancy=true` again.

```json
{
  "occupancy_group": "Washroom",
  "room": "Washroom",
  "severity": "emergency",
  "is_immediate_p0": true,
  "time": "2025-09-21T10:12:00.000Z",
  "alert_log_id": "66fabc..."
}
```

**Frontend use:** Highest priority alert — show immediately with emergency styling. `is_immediate_p0: true` distinguishes this from other alerts. Link `alert_log_id` to the alert details screen.

**Push notification:** `OCCUPANCY_NO_MOTION` (event id 42, P1, push enabled, quiet_hours_exempt)

---

## 4. `occupancy_unconfirmed_alert`

**When:** Room stuck in occupied state with zero signals from any sensor (master, door, curtain) for 4+ hours. Safety ceiling — sensors may have failed or batteries died.

**Fires once** per occupied session.

```json
{
  "occupancy_group": "Washroom",
  "room": "Washroom",
  "hours_silent": 4.2,
  "time": "2025-09-21T14:05:00.000Z",
  "alert_log_id": "66fabc..."
}
```

**Frontend use:** Show as a "please check in" advisory. Lower urgency than P0 stillness, but still important — sensors may be offline.

**Push notification:** `OCCUPANCY_UNCONFIRMED` (event id 43, P2, push enabled)

---

## Alert Log Schema (for resolve/acknowledge)

All alert socket events include `alert_log_id`. The frontend resolves alerts by patching:

```
PATCH /api/v1/alert-log/:alert_log_id
Body: { "is_resolved": true }
```

Once `is_resolved: true` on the L3 long_stay alert_log, the emergency repeat loop stops.

---

## Summary Table

| Event Name | Trigger | Severity | Repeats? |
|---|---|---|---|
| `room_occupancy_update` | Every state/sensor change | informational | Every event |
| `occupancy_long_stay_alert` | Occupied > threshold | warning → critical → emergency | L3 repeats every 5 min |
| `occupancy_no_motion_alert` | Occupied + no motion 1 min | emergency (P0) | Once per session |
| `occupancy_unconfirmed_alert` | 4h zero signals | warning | Once per session |
