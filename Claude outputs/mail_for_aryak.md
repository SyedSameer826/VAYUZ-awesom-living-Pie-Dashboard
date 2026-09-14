Hi Aryak,

Please find the update below that you can forward to Manu. It covers three things: the data issues Manu reported (snoring time + low HR notification), the complete vital alert notification logic he asked for, the bridge v25 overnight results, and a ready-to-forward mail for the GLK team regarding device configuration for per-minute sleep stage data.

---

**FOR MANU (copy below):**

---

Hi Manu,

Thank you for flagging the data inconsistencies and for the detailed feedback on the bridge v25 overnight capture. We've investigated everything thoroughly and have fixes deployed. Here's the complete update.

---

## PART A — DATA ISSUES — IDENTIFIED AND FIXED

### 1. SNORING TIME EXCEEDING TOTAL SLEEP TIME

**Identified and fixed.** We found the calculation issue in the dashboard, corrected it, and verified the fix against the DB data. Snoring duration will now always be consistent with the displayed sleep time. The fix is applied to both the summary and detail APIs.

---

### 2. LOW HEART RATE NOTIFICATION — WORKING CORRECTLY

The Low Heart Rate notifications at 05:49 and 06:36 were legitimate alerts. The DB confirms the person's heart rate dropped to **43–44 bpm** during those times, which is below the normal threshold. The actual readings that triggered the notifications:

| Time (IST) | Heart Rate | Status |
|---|---|---|
| 05:48 | 44 bpm | In-bed |
| 05:49 | 43 bpm | In-bed |
| 05:56 | 47 bpm | In-bed |
| 05:57 | 45 bpm | In-bed |
| 06:35 | 47 bpm | In-bed |

These are real vitals readings captured by the GLK sensor — the notifications fired correctly based on the threshold logic described below.

---

## PART B — VITAL ALERT NOTIFICATION LOGIC

As requested, here is the complete logic for heart rate and respiration rate notifications, and the medical rationale behind each threshold.

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
| Danger | 10 – 11 brpm OR 23 – 25 brpm | "Low Breathing Rate" / "High Breathing Rate" |
| Critical | Below 10 brpm OR Above 25 brpm | Critical vital alert |

### How the Alert System Works

1. **1-minute check cycle**: A scheduled job runs every 60 seconds. For each active GLK device, it reads the most recent vital reading from the database.

2. **Sensor settling cooldown (2 minutes)**: When a person first lies on the pad, the GLK sensor needs 90–120 seconds to calibrate. Initial readings are unreliable (e.g., RR may briefly read 9 before stabilizing at 18). All vital alerts are suppressed for 2 minutes after the person gets on the pad to avoid false positives from calibration noise.

3. **Threshold evaluation**: The system checks current HR and RR against the configured thresholds. If either value falls outside the "normal" range, the system determines the alert level and which vital drove it. If both are abnormal, the higher severity wins (HR takes priority in ties).

4. **Direction detection**: The system determines whether the value is "low" (below normal minimum) or "high" (above normal maximum), and fires the corresponding notification:
   - HR below 50 → "Low Heart Rate"
   - HR above 100 → "Elevated Heart Rate"
   - RR below 12 → "Low Breathing Rate"
   - RR above 22 → "High Breathing Rate"

5. **5-minute cooldown**: After sending a vital alert, the system waits 5 minutes before sending another one for the same device. This prevents alert flooding when vitals are hovering near a threshold boundary.

6. **Zero value suppression**: When the device reports HR=0 or RR=0 (person is off the pad), no alert is generated — this is normal out-of-bed state, not a medical event.

### Medical Rationale — Why These Thresholds

**Heart Rate:**
- The American Heart Association defines normal resting heart rate as 60–100 bpm for adults.
- During deep sleep, heart rate naturally drops — in elderly adults, it can reach 50–55 bpm without concern.
- We set the normal lower bound at **50 bpm** to account for natural sleep-time dipping while still catching clinically significant bradycardia (sustained low heart rate that may indicate cardiac conduction issues).
- **Below 40 bpm** is flagged as critical because sustained bradycardia at this level in elderly individuals may indicate serious cardiac conduction problems and warrants immediate attention.
- **Above 100 bpm** during sleep is flagged as elevated (resting tachycardia) — may indicate fever, dehydration, anxiety, or cardiac issues. Above 120 bpm is critical.

**Respiration Rate:**
- Normal adult resting respiratory rate is 12–20 breaths per minute.
- During REM sleep, elderly adults naturally reach 21–22 brpm due to irregular breathing patterns characteristic of REM. We widened the normal upper bound from 20 to **22 brpm** specifically to prevent false "High Breathing Rate" notifications during normal REM phases.
- **Below 12 brpm** during sustained periods may indicate respiratory depression or obstructive events. Below 10 is critical.
- **Above 25 brpm** (tachypnea) may indicate respiratory distress, pain, fever, or anxiety. Above 30 is critical.

**Why this matters for elderly monitoring:**
These thresholds are calibrated specifically for monitoring elderly individuals during sleep. They are intentionally cautious — alerting on the side of safety — while the 2-minute settling cooldown and 5-minute alert cooldown prevent alarm fatigue from transient or noisy readings. Every threshold has a clinical basis and is designed so that caregivers receive actionable alerts without being overwhelmed by false positives.

---

## PART C — BRIDGE v25 OVERNIGHT CAPTURE RESULTS

### 1. TIMESTAMP FIX — VERIFIED

Fixed and verified. The root cause was the Time Sync ACK format — the bridge was sending a 6-byte packed-BCD payload, but the GLK device expects a 4-byte big-endian Unix epoch. Corrected and deployed. All timestamps now correctly show 2026.

### 2. ACK LOOP — FULL NIGHT CONFIRMED

1,170 sleep stage (0x4E) frames received and ACK'd continuously overnight. Steady 1-per-minute interval, zero disconnects. The loop is solid.

### 3. 0x0E vs 0x4E — SEPARATE FIELDS

Implemented as specified:
- `glk_status` — from 0x0E realtime status byte
- `glk_sleep_stage` — from 0x4E sleep stage byte
- `sleep_stage` — bridge's own derived field from presence logic

Never merged. Verified in overnight DB data.

### 4. BODY MOVEMENT — BCG AMPLITUDE CONFIRMED

808 records overnight confirm your suspicion — this field represents BCG signal amplitude, not physical movement:
- During snoring: avg 164.7 (chest vibrations)
- During quiet in-bed: exactly 0
- `activity` and `body_movement` identical in all records — same source byte

Waiting for protocol doc V1.0.2.3 to formally confirm. Not building on this field until then.

### 5. 0x4E SLEEP STAGE — DEVICE CONFIGURATION NEEDED FOR PER-MINUTE DATA

This is the key finding. The full-night capture shows the local TCP stream produces very limited sleep stage data:

| 0x4E Sleep Stage | Records | When |
|---|---|---|
| null (no data) | 738 | First ~5 hours on pad |
| invalid | 31 | Out-of-bed transitions |
| awake | 39 | After ~5 hours |
| deep, light, rem | 0 | Not produced in this session |

Your earlier REM frame identification (Byte 11 = 5) proved the device is capable of classifying deeper stages. But the current device configuration is not producing per-minute sleep stage classification (light, deep, REM) through the local TCP stream.

**We need the GLK team's help to configure the device so that per-minute log data with proper sleep stage classification comes through the local TCP connection.** A draft mail for forwarding to the GLK team is included in Part D below.

### 6. STORING RAW, ACTING ON ALMOST NOTHING

- `is_person_on_bed` — working reliably, correctly timestamped
- HR and RR — logging only
- `body_movement` — logging only, awaiting protocol doc
- 0x4E sleep stages — logging and capturing, continuing nightly

### 7. WRITE VOLUME

5-second batch cycle. Overnight: 2.6 MB raw binary, 808 POST requests over ~7 hours. Across 15 homes: ~39 MB/day.

### 8. RAW FRAME CAPTURE

Capturing: `20260910_332014813081.bin` (2.6 MB). All frame types logged. Ready for protocol analysis or to share with GLK team.

---

## PART D — MAIL FOR GLK TEAM (FOR FORWARDING)

Below is a draft mail that can be forwarded to the GLK team to request device configuration for per-minute sleep stage data:

---

**Subject: GLK AI Smart Sleep Monitor — Device Configuration for Per-Minute Sleep Stage Classification via Local TCP**

Dear GLK Technical Team,

We are integrating the GLK AI Smart Sleep Monitor (WiFi-compact variant) into our elderly care monitoring platform. The device is connected via local TCP on port 8766, and we are successfully receiving both 0x0E (realtime vitals) and 0x4E (sleep stage) frames.

**Current status — what is working:**
- 0x0E frames: Heart rate, respiration rate, body movement, and occupancy status arriving at ~1 frame/second — all correct.
- 0x4E frames: Arriving at the expected 1-per-minute interval. Our bridge ACKs them correctly — we received 1,170 consecutive frames in a single overnight session with zero disconnects.

**What we need help with:**
The 0x4E sleep stage frames we receive do not contain actual per-minute sleep stage classifications for most of the session:
- For the first ~5 hours of continuous pad occupancy, the sleep stage byte is null/empty.
- After ~5 hours, the frames begin reporting "awake" only.
- We have not observed light sleep, deep sleep, or REM classifications through the local TCP stream, although we confirmed the device can classify REM (we received one frame with sleep stage byte = 5 = REM during an earlier test).

**Our request:**
1. **Device configuration or firmware setting** that enables the device to send per-minute sleep stage classification (awake, light, deep, REM) through the local TCP 0x4E frames. We need each frame to carry the computed sleep stage rather than null/placeholder values.

2. **Protocol document version V1.0.2.3** — to confirm the byte mapping for body movement (Byte 8 of 0x0E) and any configuration parameters that control sleep stage output frequency and accuracy.

3. **Guidance on warm-up period** — is the ~5 hour delay before classification begins expected? Is there a configuration to reduce this, so sleep stage data begins earlier in the session?

**Device details:**
- Model: GLK AI Smart Sleep Monitor (WiFi-compact)
- Connection: Local TCP, port 8766
- Bridge: Raspberry Pi 4, Python 3.11
- Serial number: 332014813081

**Context:**
This is for a production elderly care platform. Accurate per-minute sleep stage data (light/deep/REM breakdown) through the local TCP connection is a core requirement for our sleep quality reports. All other data streams from the device are working correctly — only the sleep stage classification needs configuration support.

We can provide raw frame captures (binary logs) or packet traces if that helps with diagnosis.

Thank you for your support.

Best regards,
[Your name / Company name]

---

## SUMMARY TABLE

| Item | Status |
|---|---|
| Snoring > Sleep time issue | Identified and fixed — deployed |
| Low HR notification logic | Working correctly — HR genuinely dropped to 43 bpm |
| Vital alert thresholds | Documented above — medically grounded |
| Timestamp fix | Fixed, verified overnight |
| 0x4E ACK loop | Confirmed (1,170 frames, zero drops) |
| 0x0E / 0x4E stored separately | Confirmed |
| Body movement (BCG amplitude) | Confirmed — awaiting protocol doc V1.0.2.3 |
| 0x4E sleep stages (REM/light/deep) | Need GLK device configuration for per-minute data |
| Raw frame logging | Capturing (2.6 MB/night) |

**Next steps — need your input:**
1. **Forward the GLK team mail** (Part D above) — to get device configuration for per-minute sleep stage data through local TCP
2. **Protocol doc V1.0.2.3** — if available separately from GLK team
3. Snoring fix is deployed — please verify on the app

Best regards,
Backend Team
