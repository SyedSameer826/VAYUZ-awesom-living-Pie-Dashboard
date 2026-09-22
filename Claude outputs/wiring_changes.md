# Wiring Changes — v2 Occupancy Integration

All changes are backend-only. The Flutter app already listens for these events.

---

## 1. zigbee_service.js — Change import (line 10)

**BEFORE:**
```js
import { handle_occupancy_event } from './room_occupancy_service.js';
```

**AFTER:**
```js
import { handle_occupancy_event, handle_get_bathroom_status } from './room_occupancy_service_v2.js';
```

> `handle_get_bathroom_status` is exported but not used in this file directly — it's used in `socket/index.js` (see change #2). If you prefer to keep imports local to where they're used, skip adding it here and import it in `socket/index.js` instead.

---

## 2. socket/index.js — Update get_bathroom_status handler (lines 1-35)

**BEFORE:**
```js
import user from '../models/users.js';
import get_data from '../service/health_logs.js';
export const on_connection = (socket) => {
  // ... (lines 4-28 unchanged) ...
  socket.on('get_bathroom_status', async (data) => {
    const { device_name } = data;

    const bathroom_data = await get_data.get_bathroom_data(device_name);

    socket.emit('bathroom_status', bathroom_data);
  });
```

**AFTER:**
```js
import user from '../models/users.js';
import get_data from '../service/health_logs.js';
import { handle_get_bathroom_status } from '../service/room_occupancy_service_v2.js';
export const on_connection = (socket) => {
  // ... (lines 4-28 unchanged) ...
  socket.on('get_bathroom_status', async (data) => {
    const { device_name } = data;

    // Try v2 occupancy handler first (for sensors tagged with occupancy_group).
    // It emits 'bathroom_status' directly to the user's socket room.
    // If no v2 instance is active for this user, fall back to legacy.
    if (socket.userId) {
      handle_get_bathroom_status(socket.userId, data);
    }

    // Legacy fallback — still emits for untagged standalone motion sensors.
    const bathroom_data = await get_data.get_bathroom_data(device_name);
    socket.emit('bathroom_status', bathroom_data);
  });
```

> Both paths emit `bathroom_status` with the same schema, so sending both is harmless — the app gets the v2 answer (from the state machine) and then the legacy answer (from zigbee_logs). The v2 answer arrives first via `send_to_user` (room-based), and the legacy one via `socket.emit` (direct). The app just uses whichever it receives last.
>
> If you want cleaner single-response behavior, wrap the legacy call in an `else` that checks whether v2 found an instance. For now this is safe.

---

## 3. socket/server.js — Add tick loop, disable legacy bathroom checker (lines 7-8, 48)

**BEFORE:**
```js
import service from '../service/health_logs.js';
import hub_service from '../service/hub_service.js';
```

**AFTER:**
```js
import service from '../service/health_logs.js';
import hub_service from '../service/hub_service.js';
import { start_tick_loop } from '../service/room_occupancy_service_v2.js';
```

**BEFORE (line 48):**
```js
service.start_bathroom_alert_checker();
```

**AFTER (line 48):**
```js
// DISABLED per Occupancy_Logic_Final_Spec Section 1 — legacy bathroom
// alert system retired. The v2 occupancy state machine (bathroom_watch)
// handles all alerts now via its own tick loop.
// service.start_bathroom_alert_checker();
start_tick_loop();
```

---

## 4. Place bathroom_watch.cjs

Copy `bathroom_watch.cjs` into `server/service/` (same directory as `room_occupancy_service_v2.js`) so the `require_cjs('./bathroom_watch.cjs')` resolves.

---

## 5. MongoDB — Tag the 3 bathroom devices

Run these in the QA database (connect to the QA backend's MongoDB):

```js
// Door contact sensor → occupancy_door
db.devices.updateOne(
  { id: "Door Sensor", type: "Zigbee", status: "active" },
  { $set: { occupancy_group: "bathroom_1", sensor_role: "occupancy_door" } }
);

// Inside PIR (master, aimed at floor) → room_motion
db.devices.updateOne(
  { id: "Motion Sensor Master", type: "Zigbee", status: "active" },
  { $set: { occupancy_group: "bathroom_1", sensor_role: "room_motion" } }
);

// Doorway PIR (curtain sensor across the doorway) → threshold_motion
db.devices.updateOne(
  { id: "motion_2 Sensor Master", type: "Zigbee", status: "active" },
  { $set: { occupancy_group: "bathroom_1", sensor_role: "threshold_motion" } }
);

// Verify:
db.devices.find(
  { occupancy_group: "bathroom_1" },
  { id: 1, sensor_role: 1, occupancy_group: 1, room: 1, _id: 0 }
);
```

> **Important:** Double-check the exact `id` values match what's in your devices collection. If they use `zigbee_id` instead, adjust the query filter. The `id` field here is the Z2M friendly name.

---

## 6. health_logs.js — No change needed

The `start_bathroom_alert_checker` function stays defined in `health_logs.js` — we just commented out the call in `server.js` (change #3). This is the cleanest approach: no risk of breaking the export shape, and you can re-enable it by uncommenting one line if needed.

---

## Summary — What happens after all 6 changes

1. Server boots → `start_tick_loop()` runs the 2-second cron for BathroomWatch instances
2. Legacy `start_bathroom_alert_checker` does NOT run (commented out)
3. Sensor event arrives for a tagged device → `zigbee_service.js` routes to v2 → `bathroom_watch.cjs` state machine processes it → `bathroom_update` emitted with Flutter-compatible payload
4. Sensor event arrives for an untagged device → legacy handler, completely unchanged
5. App opens motion screen → emits `get_bathroom_status` → v2 responds with snapshot, legacy also responds as fallback
6. All other devices (emergency button, presence, contacts, GLK, AltumView, camera) → completely untouched
