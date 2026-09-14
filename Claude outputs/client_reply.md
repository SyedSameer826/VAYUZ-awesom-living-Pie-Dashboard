Hi Manu,

Thank you for the detailed feedback. We ran an overnight capture last night (Sep 9–10) with the updated bridge (v25) and here are the findings against each of your four points.

---

**1. TIMESTAMP IS A YEAR OUT**

**Fixed and verified.** The root cause was identified — the Time Sync ACK was being sent as a 6-byte packed-BCD payload, but the GLK device expects a 4-byte big-endian Unix epoch. The length mismatch caused the device to reject the ACK, retry 7 times, and disconnect. We corrected `build_time_sync_ack()` to send the proper 4-byte epoch format.

Overnight log confirmation:
- Bridge startup: `System clock: 2026-09-09 21:59:28 UTC`
- Time Sync ACK sent: `→ 2026-09-09 22:00:03 UTC (epoch=1788991203)`
- 0x4E frame timestamp: `2026-09-10 04:16:34 UTC (epoch=1789013794)`

All timestamps now correctly show **2026**, not 2025. The fix is deployed on the Pi and committed to the repo.

---

**2. CONFIRM ACK LOOP — 0x4E frames kept coming through the night**

**Confirmed working.** The bridge sent the correct 0x4E ACK (`82 05 00 <seq> 4E 01 <xor>`) after every sleep stage frame, and the device continued sending throughout the session.

- **1,170 sleep stage (0x4E) frames** received and ACK'd across the full session
- Frames arrived at a steady 1-per-minute interval from connect through to morning
- No disconnects caused by missing ACKs — the ACK loop held for the entire session

---

**3. MOVEMENT FIELD CONTRADICTION + 0x4E SLEEP STAGE DATA**

**3a. Movement field — DB analysis clarifies the picture:**

We cross-checked the overnight DB data (808 records saved to backend, path: `/api/health`) against your observation about the frame we shared earlier (`body_movement=237` during `status=snoring`).

DB-wide analysis of the `body_movement` field:

| Condition | Records | body_movement range | Average |
|---|---|---|---|
| **Snoring** (in-bed, breathing detected) | 305 | 1 – 255 | 164.7 |
| **In-bed quiet** (no snoring) | 39 | 0 – 0 | 0.0 |
| **Out-of-bed** | 462 | 0 – 255 | variable |

Key findings:
- `activity` and `body_movement` are **identical in all 808 records** — they map to the same source byte
- During snoring, **62.6% of readings are above 200** — this is a consistent pattern, not an anomaly
- During quiet in-bed (no snoring detected), body_movement drops to **exactly 0**
- The 237 value you flagged is typical for snoring — 191 out of 305 snoring records show values between 201–255

**Conclusion:** The field the device labels as "body_movement" does **not** represent physical limb/torso movement. During snoring (person lying still, rhythmic breathing), values are consistently high (avg 164.7). During quiet in-bed periods (also lying still but no snoring), values are zero. This strongly suggests the field represents **BCG signal amplitude or respiratory vibration intensity** — snoring produces strong chest vibrations that register as high "movement," while quiet breathing registers near zero. We need the GLK protocol doc **V1.0.2.3** to confirm the actual meaning of this byte.

**3b. 0x4E sleep stage data — Partial but insufficient:**

The overnight capture shows the 0x4E frames are NOT completely empty — but the data they provide is very limited:

| 0x4E glk_sleep_stage | Records | When |
|---|---|---|
| **null** (no data) | 738 | First ~5 hours on pad (21:46 – 03:02 UTC) |
| **invalid** | 31 | Scattered, during brief out-of-bed transitions |
| **awake** | 39 | After ~5 hours on pad (03:02 – 04:11 UTC only) |

The device only started producing `glk_sleep_stage=awake` after approximately **5 hours** of continuous pad occupancy. Before 03:02 UTC, all 0x4E frames returned null. And even after that threshold, every single classified frame returned only **"awake"** — no deep, light, or REM stages appeared despite the person being confirmed asleep (bridge's own analysis shows `sleep_stage=sleeping`, HR 47–79 bpm, RR 9–18 brpm, snoring detected).

One single `light_sleep` status appeared at 03:48 UTC, but this came from the 0x0E realtime status field, not from 0x4E sleep stage classification.

Meanwhile, the 0x0E realtime stream confirmed the person was in bed the entire time:
- **345 in-bed vitals** with real readings: HR 43–85 bpm (avg 62.5), RR 9–19 brpm (avg 14.5)
- In-bed period: approximately 21:46 UTC to 04:31 UTC (~6.75 hours)
- Consistent snoring detection throughout
- Signal quality: 100, Battery: 100 — hardware functioning normally

**Conclusion:** The GLK WiFi-compact device has very limited local sleep stage classification over the TCP stream. After 5+ hours it begins reporting "awake" but never progresses to actual sleep stages (deep/light/REM). The real sleep stage classification appears to be processed on the **GLK cloud server** after the raw BCG data is uploaded. This aligns with the device spec listing the integration path as "GLK cloud → Backend."

**Action needed:**
1. To get actual sleep stage data (REM, deep sleep, light sleep, awake periods), we need to integrate with the **GLK cloud API** rather than relying on the local TCP 0x4E stream. Could you share the GLK cloud API documentation or connect us with the GLK team contact for API access?
2. For the movement field, we need the GLK protocol doc **V1.0.2.3** to verify what the "body_movement" byte actually represents. Our data strongly suggests it's BCG signal amplitude, not physical movement.

---

**4. VALIDATION GATE — Raw BCG frames logged to disk + DB data confirmed**

**Implemented and capturing.** Every raw frame is now written to disk at `~/glk_raw_frames/<date>_<sn>.bin`:

- Overnight file: `20260910_332014813081.bin` — **2.6 MB** of raw binary data
- Covers the full session from connect to present
- File is append-mode, so it survives reconnects within the same day
- All frame types captured: Login, Time Sync, Device Info, Realtime (0x0E), Sleep Stage (0x4E), and any unknown commands

**DB data also confirmed flowing.** The backend received and stored **808 records** overnight:
- Steady rate of ~120 records/hour (2 per minute — one from each frame type)
- 345 in-bed records with valid vitals, 462 out-of-bed records
- All records have correct 2026 timestamps
- Data route: Pi bridge → POST /api/health → MongoDB

This raw capture can be replayed for protocol analysis or shared with the GLK team for verification.

---

**Summary of bridge v25 changes deployed:**

| Change | Status |
|---|---|
| Time Sync → 4-byte epoch (was broken 6-byte BCD) | Fixed, verified |
| 0x4E ACK loop — device keeps sending all night | Confirmed (1,170 frames) |
| 0x4E sleep stage data over TCP | Limited — only "awake" after 5h, no deep/light/REM |
| body_movement field | Not physical movement — likely BCG signal amplitude (correlates with snoring, not motion) |
| Raw frame logging to disk | Capturing (2.6 MB overnight) |
| DB data flow to backend | Confirmed (808 records, steady rate) |
| Startup clock check (year verification) | Logs system time at boot |

**Next steps:**
1. Obtain GLK cloud API documentation/access for sleep stage data
2. Obtain GLK protocol doc V1.0.2.3 to confirm body_movement byte meaning
3. Once cloud API is integrated, begin the 3-night validation comparing our data against the GLK app output

Please let us know regarding the GLK cloud API access and protocol doc, and we'll proceed accordingly.

Best regards,
Backend Team
