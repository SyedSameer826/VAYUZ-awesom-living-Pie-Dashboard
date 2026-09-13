Hi Manu,

Thank you for flagging the data inconsistencies and for the detailed feedback on the bridge v25 overnight capture. We've investigated everything thoroughly — the DB data, the dashboard calculation code, and the notification logic. Here's the complete picture.

---

## PART A — DATA CONTRADICTION INVESTIGATION

### 1. SNORING TIME EXCEEDS TOTAL SLEEP TIME

**Root cause identified — scope mismatch in the dashboard calculation.**

We traced this through the code and confirmed it against the DB data. The issue is:

- **Sleep Duration** on the dashboard is calculated from the **most recent sleep session only**. The session detection uses a state machine that opens a session when the person lies down, and closes it after 15 minutes of sustained absence. If the person gets up briefly and returns, sessions can fragment.
- **Snoring Duration** is calculated across **all readings in the full 24-hour sleep date window** (9 AM to 9 AM IST), spanning every in-bed period — not just the displayed session.

So when the person had multiple in-bed periods during the day (e.g., an afternoon rest plus the main nighttime sleep), the dashboard shows only the last session's duration as "Total Sleep Time" but aggregates snoring across all in-bed periods.

**Simulation against DB data confirms this:**

We ran the exact same calculation logic against the DB export:

| Sleep Date | Sessions Found | Last Session Duration | Snoring (All Readings) | Contradiction |
|---|---|---|---|---|
| Sep 8 | 2 sessions | 60 min (last one) | 66 min | Yes — snoring > displayed sleep |
| Sep 9 | 2 sessions | 7 min (last one) | 8.5 min | Yes |
| Sep 10 | 8 sessions | 28 min (last one) | 61 min | Yes |

In all three nights, the person had multiple sleep sessions, but the dashboard only showed the last one's duration while snoring summed across all sessions.

**Fix:** We will scope the snoring calculation to the same session that drives the displayed sleep duration, so the two numbers are always internally consistent. The fix applies to both the summary and detail APIs.

---

### 2. LOW HEART RATE NOTIFICATION — WHY IT FIRED BUT HR "NOT IN RANGE SHOWN"

**The notification was correct. The displayed HR range is from a different time window.**

This is a related scope issue:

- **Heart Rate displayed on the dashboard** is averaged within the **last sleep session only** (the same session shown as "Total Sleep Time").
- **Vital alert notifications** run on a **1-minute cron job** that checks the **most recent reading from the device** — it is not limited to any particular session. It fires whenever the latest HR or RR reading crosses a threshold.

For the Sep 10 night:
- The last session was 08:31–08:59 IST, with HR range **47–74 bpm** — this is what the dashboard displayed.
- But the Low Heart Rate notifications at **05:49 and 06:36 IST** fired from an earlier session (05:02–07:32 IST) where HR dropped to **43–44 bpm** — well below the 50 bpm threshold.
- Since the dashboard only shows the last session, those earlier low readings are not visible in the displayed HR range.

**Actual Low HR readings that triggered the notifications:**

| Time (IST) | Heart Rate | Status |
|---|---|---|
| 05:48 | 44 bpm | snoring |
| 05:49 | 43 bpm | snoring |
| 05:56 | 47 bpm | snoring |
| 05:57 | 45 bpm | snoring |
| 06:35 | 47 bpm | snoring |

These readings are real and present in the DB — the notifications fired correctly. They just came from a session that the dashboard doesn't display as the "current" one.

**Fix:** The snoring scope fix (Point 1 above) will also bring the session selection logic into alignment. Additionally, we can add a "notification history" view that shows which readings triggered each alert, so there is no confusion between displayed vitals and alert triggers.

---

### 3. DATA CONTRADICTING — SUMMARY

Both contradictions stem from the same root cause: **the dashboard shows sleep duration from the last session only, but snoring and notifications operate on the full 24-hour window.** This creates a visual mismatch where snoring appears to exceed sleep time, and notifications fire from readings not shown in the displayed range.

This is not a data corruption issue — the underlying DB data is accurate and consistent. The readings, timestamps, and vitals are all correct. The issue is purely in how the dashboard scopes its displayed values vs. how snoring aggregation and notifications scope theirs.

**Action plan:**

| Item | Fix | Timeline |
|---|---|---|
| Snoring scoped to displayed session | Code change in `get_dashboard_summary` and `get_health_checker` | Immediate |
| HR/RR display scoped consistently | Ensure displayed vitals span the same window as notifications | With above |
| Notification context | Add reading value + timestamp to notification detail | Next sprint |

---

## PART B — VITAL ALERT NOTIFICATION LOGIC

As requested, here is the complete logic for how heart rate and respiration rate notifications are triggered, and the medical rationale behind each threshold.

### Threshold Configuration

**Heart Rate (bpm):**

| Level | Range | Notification |
|---|---|---|
| Normal | 50 – 100 bpm | No alert |
| Danger | 40 – 49 bpm OR 101 – 120 bpm | "Low Heart Rate" / "Elevated Heart Rate" |
| Critical | Below 40 bpm OR Above 120 bpm | Critical vital alert |

**Respiration Rate (breaths per minute):**

| Level | Range | Notification |
|---|---|---|
| Normal | 12 – 22 brpm | No alert |
| Danger | 10 – 11 brpm OR 23 – 25 brpm | "Low Respiratory Rate" / "High Respiratory Rate" |
| Critical | Below 10 brpm OR Above 25 brpm | Critical vital alert |

### How the Alert System Works

1. **1-minute check cycle**: A cron job runs every 60 seconds. For each active GLK device, it reads the latest vital reading from the DB.

2. **Sensor settling cooldown (2 minutes)**: When a person first lies down on the pad, the GLK sensor needs 90–120 seconds to calibrate. During this window, initial readings are unreliable (e.g., RR may briefly read 9 before stabilizing at 18). We suppress all vital alerts for 2 minutes after the last out-of-bed reading to avoid false positives.

3. **Threshold evaluation**: The system checks the current HR and RR against the configured thresholds. If either value falls outside the "normal" range, the system determines the alert level and which vital drove it (HR or RR). If both are abnormal, the higher severity wins.

4. **Direction detection**: The system determines whether the value is "low" (below normal minimum) or "high" (above normal maximum), and fires the corresponding notification type:
   - HR below 50 → `GLK_LOW_HEART_RATE` → "Low Heart Rate" push notification
   - HR above 100 → `GLK_ELEVATED_HEART_RATE` → "Elevated Heart Rate" push notification
   - RR below 12 → `GLK_LOW_RESPIRATORY_RATE` → "Low Breathing Rate" push notification
   - RR above 22 → `GLK_HIGH_RESPIRATORY_RATE` → "High Breathing Rate" push notification

5. **5-minute cooldown**: After sending a vital alert, the system waits 5 minutes before sending another one for the same device. This prevents alert flooding when a person's vitals are hovering near a threshold boundary.

6. **Zero value suppression**: When the device reports HR=0 or RR=0 (person is off the pad), no alert is generated — this is normal out-of-bed behavior.

### Medical Rationale

**Heart Rate thresholds:**
- The American Heart Association defines normal resting heart rate as 60–100 bpm for adults.
- During deep sleep, heart rate naturally drops — in elderly adults, it can reach 50–55 bpm without concern.
- We set the normal lower bound at **50 bpm** (slightly below the typical 60 bpm threshold) to account for natural sleep-time dipping while still catching clinically significant bradycardia.
- **Below 40 bpm** is flagged as critical because sustained bradycardia at this level in elderly individuals may indicate cardiac conduction problems and warrants immediate attention.
- **Above 100 bpm** during sleep is unusual (resting tachycardia) and may indicate fever, anxiety, dehydration, or cardiac issues. Above 120 bpm is critical.

**Respiration Rate thresholds:**
- Normal adult resting respiratory rate is 12–20 breaths per minute.
- During REM sleep, elderly adults naturally reach 21–22 brpm due to irregular breathing patterns. We widened the normal upper bound from 20 to **22 brpm** specifically to prevent false "High Respiratory Rate" notifications during REM phases.
- **Below 12 brpm** during sustained periods may indicate respiratory depression, CNS depression, or obstructive events. Below 10 is critical.
- **Above 25 brpm** (tachypnea) may indicate respiratory distress, pain, fever, or anxiety. Above 30 is critical.

**Why these thresholds matter for elderly monitoring:**
These are not arbitrary numbers — they are calibrated for the specific use case of monitoring elderly parents during sleep. The thresholds are intentionally set to be cautious (alerting on the side of safety) while accounting for normal physiological variations during sleep. The 2-minute settling cooldown and 5-minute alert cooldown prevent alarm fatigue from transient readings.

---

## PART C — BRIDGE v25 OVERNIGHT CAPTURE RESULTS

*(Updated from previous communication — includes full-night validation data)*

### 1. TIMESTAMP FIX — VERIFIED

Fixed and verified. The root cause was the Time Sync ACK format — the bridge was sending a 6-byte packed-BCD payload, but the GLK device expects a 4-byte big-endian Unix epoch. We corrected `build_time_sync_ack()` to send the proper epoch. All timestamps now correctly show 2026. Fix deployed on the Pi and committed.

### 2. ACK LOOP — FULL NIGHT CONFIRMED

1,170 sleep stage (0x4E) frames received and ACK'd continuously overnight. Steady 1-per-minute interval, zero disconnects. The ACK loop is solid.

### 3. 0x0E vs 0x4E — SEPARATE FIELDS

Implemented as specified. The pipeline stores them as distinct fields:
- `glk_status` — from 0x0E realtime status byte
- `glk_sleep_stage` — from 0x4E sleep stage byte
- `sleep_stage` — bridge's own derived field, computed from presence logic

Never merged. Verified in overnight DB data.

### 4. BODY MOVEMENT — BCG AMPLITUDE CONFIRMED

Full-night data (808 records) confirms your suspicion — this field represents BCG signal amplitude, not physical limb movement:
- During snoring: avg 164.7, 62.6% above 200 (chest vibrations)
- During quiet in-bed: exactly 0 in every record
- `activity` and `body_movement` identical in all 808 records — same source byte

Waiting for protocol doc V1.0.2.3 to formally confirm. Not building on this field until then.

### 5. 0x4E SLEEP STAGE — DEVICE CONFIGURATION NEEDED

This is the key finding. The full-night capture shows the device's local TCP stream produces very limited sleep stage data:

| 0x4E Sleep Stage | Records | When |
|---|---|---|
| null (no data) | 738 | First ~5 hours on pad |
| invalid | 31 | Out-of-bed transitions |
| awake | 39 | After ~5 hours |
| deep, light, rem | 0 | Not produced in this session |

The device needs approximately 5 hours of continuous pad occupancy before any classification begins, and even then only produced "awake" labels. Your earlier identification of a REM frame (Byte 11 = 5) proved the decode logic is sound — the device is capable of classifying deeper stages, but the current configuration is not producing them reliably through the local TCP stream.

**What we need from the GLK team:** Device configuration or firmware settings that enable per-minute sleep stage classification (light, deep, REM) through the local TCP connection. The device is clearly capable of this classification internally — we need the configuration that activates it for the local stream, so each 0x4E frame carries the actual computed sleep stage rather than null/awake placeholders.

### 6. STORE EVERYTHING, ACT ON ALMOST NOTHING

Following your guidance:
- `is_person_on_bed` — working reliably, correctly timestamped
- HR and RR — logging only (no display thresholds until baseline from real homes)
- `body_movement` — logging only, awaiting protocol doc
- 0x4E sleep stages — logging and capturing, continuing nightly

### 7. WRITE VOLUME

5-second batch cycle, not per-frame. Overnight: 2.6 MB raw binary, 808 POST requests over ~7 hours. Across 15 homes: ~39 MB/day. Manageable.

### 8. RAW FRAME CAPTURE

Implementing and capturing: `20260910_332014813081.bin` (2.6 MB raw binary). All frame types logged. Ready for protocol analysis or to share with the GLK team.

---

## PART D — MAIL FOR GLK TEAM (FOR FORWARDING)

Below is a draft mail that can be forwarded to the GLK team to request device configuration for per-minute sleep stage data:

---

**Subject: GLK AI Smart Sleep Monitor — Device Configuration for Per-Minute Sleep Stage Data via Local TCP**

Dear GLK Technical Team,

We are integrating the GLK AI Smart Sleep Monitor (WiFi-compact variant) into our elderly care monitoring platform. The integration uses the local TCP connection on port 8766 to receive real-time data from the device.

**Current status:**
- Our bridge software is successfully connected to the device and receiving both 0x0E (realtime vitals) and 0x4E (sleep stage) frames continuously.
- 0x0E frames are working correctly — we receive heart rate, respiration rate, body movement, and status data at ~1 frame/second.
- 0x4E frames are arriving at the expected 1-per-minute interval, and we are ACK-ing them correctly (1,170 frames received in a single overnight session with zero disconnects).

**The issue:**
The 0x4E sleep stage frames we receive through the local TCP stream do not contain actual sleep stage classifications for most of the session:
- For the first ~5 hours of continuous pad occupancy, the sleep stage byte in 0x4E frames is null/empty.
- After ~5 hours, the frames begin reporting "awake" only.
- We have not observed light sleep, deep sleep, or REM classifications through the local TCP stream in our testing, although we know the device is capable of this classification (we received one REM frame during an earlier test session — Byte 11 = 5, which correctly decodes as REM per the protocol spec).

**What we need:**
1. **Device configuration or firmware setting** that enables per-minute sleep stage classification (awake, light, deep, REM) through the local TCP 0x4E frames. We need each frame to carry the computed sleep stage, not null/placeholder values.

2. **Protocol document version V1.0.2.3** — we have the earlier protocol spec but need the updated version to confirm the exact byte mapping for body movement (Byte 8 of 0x0E) and any configuration parameters that control sleep stage output.

3. **Guidance on warm-up period** — is there a device setting that controls how long the sensor needs before it begins sleep stage classification? In our testing, the device requires ~5 hours before any stage data appears. Is this expected behavior, or is there a configuration to reduce this warm-up period?

**Our setup:**
- Device model: GLK AI Smart Sleep Monitor (WiFi-compact)
- Connection: Local TCP on port 8766
- Bridge platform: Raspberry Pi 4, Python 3.11
- Firmware version: [to be confirmed by Manu]
- Serial number: 332014813081

**Context:**
This is for a production elderly care platform monitoring 15+ homes. Accurate per-minute sleep stage data (light/deep/REM breakdown) is a core requirement for our sleep quality reports. We are currently receiving all other data correctly — only the sleep stage classification needs configuration.

We would appreciate any guidance on device configuration, firmware updates, or protocol settings that would enable this capability. We can provide raw frame captures (binary logs) or packet traces if that helps with diagnosis.

Thank you for your support.

Best regards,
[Your name / Company name]

---

## SUMMARY TABLE

| Item | Status | Action |
|---|---|---|
| Snoring > Sleep time contradiction | Root cause found (scope mismatch) | Code fix — scope snoring to displayed session |
| Low HR notification vs displayed range | Explained (different time windows) | Code fix — align vitals display with notification window |
| Vital alert thresholds | Documented above | Working as designed, medically grounded |
| Timestamp fix (BCD → epoch) | Fixed, verified overnight | Done |
| 0x4E ACK loop | Confirmed (1,170 frames, zero drops) | Done |
| 0x0E / 0x4E stored separately | Confirmed | Done |
| Body movement (BCG amplitude) | Confirmed | Awaiting protocol doc V1.0.2.3 |
| 0x4E sleep stages (REM/light/deep) | Not coming from device currently | Need GLK team configuration support |
| Raw frame logging | Capturing (2.6 MB/night) | Ongoing |

**Next steps — need your input:**
1. **Forward the GLK team mail** (Part D above) — to get device configuration for per-minute sleep stage data
2. **Protocol doc V1.0.2.3** — if available separately from GLK team
3. We will deploy the snoring/vitals scope fix and share updated results

Best regards,
Backend Team
