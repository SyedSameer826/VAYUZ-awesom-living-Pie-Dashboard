# Device-Wise Use Cases — Complete Audit

**Awesom Living Smart Home Platform**
Generated: September 18, 2026 | Covers all development sessions (April 2025 — September 2026)

---

| Metric | Count |
|---|---|
| **Total Use Cases** | 82 |
| **Device Categories** | 9 |

| Device | Use Cases |
|---|---|
| GLK Vital Tracker | 18 |
| Motion Sensor | 6 |
| Presence Sensor | 2 |
| Door/Window Contact Sensors | 5 |
| Emergency Button | 2 |
| AltumView Sentinare | 1 |
| CP Plus Camera | 6 |
| Raspberry Pi Hub | 22 |
| Cross-Device / Platform | 20 |

---

## 1. GLK Vital Tracker — Sleep / Vitals Sensor (18)

*Sole vitals and sleep monitoring device. Replaced Emfit sensor.*

1. **Sleep date attribution fix** — GLK reports data at 2-6 AM; fixed logic so sessions attribute to the correct sleep date, not the calendar date of the raw timestamp
2. **Snoring / activity / restless data leaking from previous day** — data from a prior night was bleeding into the current day's response; fixed fetch window boundaries
3. **ROOT CAUSE of empty sleep sessions** — GLK source detection missed cloud webhook format (glk_cloud vs glk_local); sessions appeared empty because ingestion didn't recognize the payload
4. **previous_sleep_session computation fix** — the "compared to last night" comparison was pulling the wrong session
5. **GLK fetch window fix** — API query window wasn't aligned with actual data arrival pattern (2-6 AM next day)
6. **15-minute minimum duration filter** — added to discard spurious micro-sessions (sensor noise, brief power events)
7. **Device-offline close in build_sleep_sessions** — sessions left open when device went offline are now properly closed
8. **merge_close_sessions widened 15 min to 30 min** — adjacent sessions separated by brief gaps (bathroom trip) merged into one continuous night
9. **110-minute data gap analysis** — analyzed raw data and proved the gap was GLK sensor going silent (hardware), not a software bug
10. **device_id: null in create_emfit_log** — log creation wasn't attaching the device ID; fixed
11. **Backfilled device_id on all 734 existing emfit_logs records** — retroactive data integrity fix
12. **get_sleep_date_range window fix** — date range query for sleep data was off by one day
13. **Only last sleep session in APIs** — enforced user requirement that APIs return only the most recent session
14. **Removed _debug / _session_debug from API response** — cleanup of temporary debugging data from production response
15. **GLK vitals completeness fix (v20)** — signal_quality field was extracted but never returned; fixed to forward all 13 raw device fields including heart_rate, respiration_rate, battery_level, signal_quality, etc.
16. **GLK BLE transport fix (v9)** — provisioning was failing (wifi_ack=false, 502) because BLE write used response=True which GLK fff1 characteristic doesn't support; fixed to response=False with 0.12s inter-chunk delay
17. **GLK pairing 502 fix (v8)** — server.js reads glk_provision.py from wrong path; setup script only deployed improved version to one location. Fixed: copy into both locations
18. **GLK emergency frame forwarding (v20)** — emergency (0x0D) frames now forward decoded fields (life_abnormality=true, status_code=5) instead of raw hex, enabling backend push notifications

> *Note: Resident dropdown kept for GLK pairing only (removed from all other device forms).*

---

## 2. Motion Sensor — SONOFF SNZB-03 Zigbee (6)

*Room-level motion detection for occupancy and "no motion" alerts.*

1. **Motion sensor flickering + stale presence bug fix** — dashboard showed rapid on/off flickering and stale "motion detected" that never cleared
2. **Motion sensor pairing UI** — added "Paired Motion Sensor" and "Paired Window/Door Sensor" dropdowns to dashboard device form for door-aware occupancy linking
3. **"Too long in room" no-motion alerts — 3 critical bugs fixed:** (1) Alert timer not resetting on new motion events, (2) Grace period calculation wrong, (3) Alert firing during normal occupancy patterns
4. **Motion sensor alert grace period bug** — configurable grace period before "no motion" alert wasn't being respected
5. **Motion sensor alerts not firing — 3 root causes:** (1) Zigbee event path not triggering alert evaluation, (2) Home-based device lookup failing, (3) Alert threshold comparison inverted
6. **Multiple paired window sensor filter fixes** — filter associating a contact sensor with its paired motion sensor had edge cases where wrong sensor matched

---

## 3. Presence Sensor — SONOFF SNZB-06P Zigbee (2)

*mmWave-based presence detection — detects stationary persons (sitting/sleeping).*

1. **Occupancy showing false while person is sitting still** — presence sensor correctly reported occupancy but dashboard showed "unoccupied" due to logic error in state aggregation
2. **Door-aware occupancy logic (complete implementation)** — presence + motion + door sensor data combined: if door opens and presence drops, person left; if presence stays, person is still there despite door activity

---

## 4. Door/Window Contact Sensors — SONOFF SNZB-04 Zigbee (5)

*Open/close detection for doors and windows. Can be paired with motion sensors.*

1. **Contact sensor filter fixed to use normalize_sensor_type** — sensor type strings weren't normalized, causing filter mismatches
2. **Contact sensor filter updated: only hide those paired with motion sensor** — standalone door sensors appear in user app; only those paired as "window sensor" hidden
3. **Cloud backend: hide contact sensors from user app listing** — paired contact sensors are infrastructure (motion sensor helper), not user-facing
4. **Paired window sensor event leaking to standalone Door Sensor** — when a contact sensor was paired with motion sensor, its events appeared on unrelated standalone door sensor log
5. **Resident dropdown removed from contact sensor pairing form** — contact sensors don't need resident assignment

---

## 5. Emergency Button — SONOFF SNZB-01 Zigbee (2)

*One-press SOS alert for the elderly resident.*

1. **Emergency button alert_log not saving to DB** — button press events were received via Zigbee/MQTT but alert log entry wasn't being persisted to MongoDB
2. **Diagnosed empty alert_logs for emergency button** — traced full event path from Zigbee2MQTT to MQTT bridge to backend webhook to DB write to locate the break point

---

## 6. AltumView Sentinare — Fall Detection Camera (1)

*AI-powered fall detection ONLY. Does NOT do presence, motion, or sleep.*

1. **"Danger - UNKNOWN" alert fix** — fall detection alerts showed "Danger - UNKNOWN" instead of proper alert message; fixed alert type mapping on both qa and master branches

> *Critical correction: AltumView does FALL DETECTION ONLY. AltumView provisioning requires WPA2 Personal WiFi.*

---

## 7. CP Plus Camera — RTSP Video Stream (6)

*IP camera for live video feed via RTSP, proxied through go2rtc on the Pi.*

1. **Camera stream debugging — COMPLETED** — full end-to-end troubleshooting of RTSP to go2rtc to WebRTC/HLS pipeline on the Pi
2. **Camera checker CAMERA_ONLINE/OFFLINE resident lookups fixed** — periodic camera health check was failing to find associated resident, so online/offline status wasn't reported
3. **go2rtc configuration** — set up as part of every Pi deployment for proxying CP Plus RTSP stream to dashboard via WebRTC
4. **Camera IP/DHCP fix** — camera IP changed from 192.168.50.102 to .100 (DHCP moved it); stream name fixed to match MongoDB record
5. **Multi-camera support (v3)** — CAMERAS array replaces single CAMERA_IP/CAMERA_STREAM_NAME; go2rtc.yaml generated with ALL camera streams; camera-wrapper TCP probes all cameras in parallel
6. **Bulk heartbeat (v3)** — camera-wrapper calls /api/camera/bulk-heartbeat with array of all camera statuses instead of single-camera heartbeat

---

## 8. Raspberry Pi Hub — Infrastructure (22)

*Central hub running Zigbee2MQTT, MQTT broker, go2rtc, dashboard, and all bridges.*

1. **Multiple pisetup versions built:** v3, v4, v5, v8, v9, v20, v23, v25, v26, v27, v27.1, v27.2, v28 — each adding fixes and features
2. **Fresh Pi setup completed** — full deploy: dashboard + camera + Zigbee + MQTT + GLK + hub heartbeat
3. **Home mapping** — POST /api/hub/setup with home_id to bind Pi to a specific home
4. **Zigbee service + cron checkers fixed for home-based device mapping** — checkers were looking up devices by resident instead of by home
5. **DS3231 RTC clock chip setup on QA Pi** — hardware real-time clock for accurate timestamps without NTP
6. **Hub heartbeat implementation** — periodic heartbeat from Pi to cloud backend so app knows hub is online
7. **SD card corruption root cause analysis** — deep investigation identifying SDIO bus (shared between WiFi and SD card) as hardware-level root cause; formal DOCX report produced
8. **SSD migration (USB boot)** — EEPROM bootloader update, Sounce adapter compatibility (UAS quirks, autosuspend disable, blacklist), cmdline.txt + config.txt config, live filesystem auto-expansion
9. **Hub status log collection** — created hub_status_log MongoDB collection with model + API endpoint
10. **Hardware watchdog (v28)** — enabled Pi's hardware watchdog timer for auto-reboot on hang
11. **Network hardening (v28)** — WiFi reconnect scripts, connection monitoring
12. **Cudy TR1200 router internet connectivity fix** — diagnosed and fixed QA network internet access
13. **Autossh tunnel replaced by Cloudflare named tunnel (v5)** — token-based named tunnel; installs cloudflared, registers URL via POST /api/hub/tunnel
14. **Cloudflare ingress rules fix (v23)** — token-based cloudflared sometimes fails to pull ingress config causing "No ingress rules" + HTTP 503; fix creates explicit config.yml
15. **Mosquitto MQTT broker + Zigbee2MQTT** — configured on each Pi deployment with SONOFF Zigbee dongle
16. **Auto-retry function (v23)** — retry() with exponential backoff (5s-60s, 6 attempts) applied to apt-get, Node.js install, npm install, git clone/pull, cloudflared download
17. **Service health checks (v23)** — check_service_health() verifies systemd services are active after start, auto-restarts up to 3 times; check_pm2_health() for PM2 processes
18. **PM2 boot persistence fix** — Pi was dead after 12hr power-off; pm2 startup systemd now runs unconditionally; falls back to manual systemd service creation; @reboot cron as backup
19. **Static IP baked into setup script (v26)** — static IP 192.168.50.106 configured inside setup-pi-fresh.sh; supports both dhcpcd (Bullseye) and NetworkManager (Bookworm+)
20. **Live filesystem auto-expansion (v27.2)** — auto-detects undersized root (<10GB free) and expands live using parted + resize2fs without reboot
21. **Deploy script gateway exclusion (v5)** — Cudy router excluded from Pi auto-discovery because its Broadcom chip responded to SSH probe
22. **Deploy scripts for Mac + Windows** — deploy-pi.command (Mac, sshpass) and deploy-pi.ps1 (Windows, Posh-SSH) with env selector (Prod/QA)

---

## 9. Cross-Device / Platform-Wide (20)

*Fixes and features spanning multiple devices or the platform as a whole.*

1. **Resident dropdown removal from ALL device forms except GLK** — simplified pairing flow; home-based mapping replaced per-resident assignment
2. **Sync button implementation** — dashboard UI button to force-sync all device states
3. **handleSave fix — frontend re-fetches after save** — after saving device config, UI pulls fresh data instead of showing stale state
4. **Device listing ignoring home filter — fixed** — device list API wasn't filtering by selected home
5. **"Unauthorized device access" in device_controller.js — fixed** — legitimate device requests were being rejected
6. **Alerts route ordering in user_device_route.js — fixed** — route parameter conflicts caused alerts endpoint to 404
7. **debug_dashboard_data diagnostic function added** — helper to dump full dashboard data state for troubleshooting
8. **Timezone bug in requested_date — fixed** — IST vs UTC offset was shifting which day's data was returned
9. **ESLint snake_case enforcement** — applied id-match rule across codebase
10. **CI/CD git pull failure diagnosed and fixed** — deployment pipeline was broken
11. **EC2 Docker container name conflict resolved** — QA backend container couldn't start due to name collision
12. **server.js corruption fix** — removed duplicated content + merge marker from server.js after bad merge
13. **All merge conflicts resolved on both repos** — qa + master branches for both Pi Dashboard and Backend repos
14. **Push notification event/screen mapping** — wired up which alert types trigger which push notifications and which app screen they deep-link to
15. **Zigbee type auto-detection fix (v25)** — mqttClient.js type detection broken for freshly-paired devices; also checks dev.definition.exposes array; DeviceForm.jsx got Temperature, Leak, Zigbee added to type dropdown
16. **MQTT bridge dotenv fix (v4)** — bridge always hitting production because dotenv wasn't imported before reading process.env.BACKEND_URL; added inline env vars via PM2 as backup
17. **Frontend auth.js fix (v4)** — login was getting prod token which Pi forwarded to QA causing 401 Unauthorized; fixed auth.js to always read VITE_BACKEND_URL; .env created for both environments
18. **server.js assign-name crash fix (v4)** — Z2M configuration.yaml may have no "devices:" key on fresh installs; original code crashed with TypeError; fixed with try/catch + null check
19. **Diagnosed dashboard empty data for Sep 17** — investigated and explained why dashboard showed no data for a specific date
20. **Implementation spec documents created** — formal specification documents for device integration and dashboard logic

---

*Confidential | VAYUZ Technologies, Noida*
