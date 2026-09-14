Hi Aryak,

Below is the consolidated update for Manu — covers data issues, sleep session merge fix, vital alert logic, bridge v25 results, sensor observation, and a GLK team mail for forwarding.

**Attached:** Awesom Living — Sleep Dashboard Complete Calculation Logic Document (v1.1). This is the full reference for how every number on the dashboard is calculated, including the updated session merge rule and the Sep 10 DB calculation log (Section 14).

---

**FOR MANU (copy below):**

---

Hi Manu,

Thanks for flagging the data issues and for the bridge v25 feedback. Everything has been investigated and fixes are deployed. Here's the full update.

---

## PART A — DATA ISSUES

### 1. Snoring Time Exceeding Total Sleep Time

**Identified and fixed.** The calculation issue in the dashboard has been corrected and verified against DB data. Snoring duration will now always be consistent with the displayed sleep time. Fix applied to both summary and detail APIs.

### 2. Low Heart Rate Notification — Working Correctly

The Low HR notifications at 05:49 and 06:36 were legitimate. The DB confirms heart rate dropped to **43–44 bpm** during those times, below the normal threshold:

| Time (IST) | Heart Rate | Status |
|---|---|---|
| 05:48 | 44 bpm | In-bed |
| 05:49 | 43 bpm | In-bed |
| 05:56 | 47 bpm | In-bed |
| 05:57 | 45 bpm | In-bed |
| 06:35 | 47 bpm | In-bed |

These are real vitals captured by the GLK sensor — notifications fired correctly per the threshold logic in Part B.

### 3. Heart Rate & Respiration Rate Dropping to Zero

The 30-minute chart for Sep 10 shows HR and RR dropping to **0** at **04:30 AM** and **08:00 AM**. Both vitals drop simultaneously and recover in the next bucket.

**The sensor reported "out of bed" status during these windows.** When the sensor reports out-of-bed, both readings go to zero since the sensor has no body contact to measure. The chart shows 30-min averages, so any bucket where the sensor reported off-pad shows 0.

| Time Slot | Heart Rate | Respiration Rate | Sensor Status |
|---|---|---|---|
| 04:00 AM | 64 bpm | 17 brpm | In bed — normal |
| **04:30 AM** | **0** | **0** | **Sensor reported out-of-bed (~59 min, from 04:04 to 05:02 AM)** |
| 05:00 AM | 62 bpm | 15 brpm | Back in bed — normal |
| 07:30 AM | 62 bpm | 13 brpm | In bed — normal |
| **08:00 AM** | **0** | **0** | **Sensor reported out-of-bed (~59 min, from 07:32 to 08:31 AM)** |
| 08:30 AM | 61 bpm | 14 brpm | Back in bed — normal |

**DB confirms:** The sensor logged continuous `out_of_bed` status with HR=0 and RR=0 for both periods — **~59 minutes each**. However, **this may be a sensor pad sensitivity issue rather than actual absence from bed** — see Part E for details.

### 4. Sleep Session Merge Rule — Updated

We identified that the sleep session logic had a **60-minute merge rule** — if two sleep sessions had a gap of up to 60 minutes between them, they were merged into one continuous session. This was too aggressive, as it was hiding genuine wake-ups and merging sessions that should have been separate.

**Fix deployed:** The merge rule has been reduced from **60 minutes to 15 minutes**. Now:

- Gaps **≤ 15 min** (bathroom visit, water) → merged into one session (expected brief wake-up)
- Gaps **> 15 min** → kept as separate sleep sessions (genuine wake-up or significant break)

This means the dashboard will now show more accurate sleep session boundaries. If someone wakes up for 20+ minutes, it will correctly appear as a separate session instead of being hidden inside a merged block.

---

## PART B — VITAL ALERT NOTIFICATION LOGIC

### Thresholds

| Vital | Level | Range | Notification |
|---|---|---|---|
| Heart Rate | Normal | 50 – 100 bpm | No alert |
| Heart Rate | Danger | 40 – 49 bpm OR 101 – 120 bpm | "Low Heart Rate" / "Elevated Heart Rate" |
| Heart Rate | Critical | Below 40 OR Above 120 bpm | Critical vital alert |
| Respiration | Normal | 12 – 22 brpm | No alert |
| Respiration | Danger | 10 – 11 OR 23 – 25 brpm | "Low Breathing Rate" / "High Breathing Rate" |
| Respiration | Critical | Below 10 OR Above 25 brpm | Critical vital alert |

### How It Works

1. **1-minute check cycle** — reads the latest vital reading per device every 60 seconds.
2. **2-minute sensor settling cooldown** — suppresses alerts for 2 min after person gets on pad (sensor calibration produces unreliable initial readings).
3. **Threshold evaluation** — checks HR and RR against thresholds. If both abnormal, higher severity wins; HR takes priority in ties.
4. **Direction detection** — determines "low" vs "high" to fire the correct notification type.
5. **5-minute cooldown** — no repeat alert for the same device within 5 min (prevents flooding when vitals hover near a threshold).
6. **Zero suppression** — HR=0 / RR=0 means off-pad, not a medical event. No alert generated.

### Medical Rationale

**Heart Rate:** AHA defines normal resting HR as 60–100 bpm. During deep sleep, elderly adults naturally drop to 50–55 bpm, so we set the lower bound at **50 bpm** to avoid false alarms while catching clinically significant bradycardia. Below 40 bpm is critical (possible cardiac conduction issues). Above 100 bpm during sleep is elevated (possible fever, dehydration, cardiac issues); above 120 is critical.

**Respiration Rate:** Normal is 12–20 brpm. During REM, elderly adults reach 21–22 brpm naturally, so we widened the upper bound to **22 brpm** to prevent false alerts during normal REM phases. Below 12 may indicate respiratory depression; below 10 is critical. Above 25 (tachypnea) may indicate respiratory distress; above 30 is critical.

These thresholds are calibrated for elderly sleep monitoring — cautious enough to catch real issues, with cooldowns to prevent alarm fatigue.

---

## PART C — BRIDGE v25 OVERNIGHT RESULTS

| Item | Result |
|---|---|
| **Timestamp fix** | Fixed. Root cause: bridge sent 6-byte packed-BCD, device expects 4-byte big-endian Unix epoch. All timestamps now show 2026. |
| **ACK loop** | 1,170 sleep stage (0x4E) frames received overnight. Steady 1/min, zero disconnects. |
| **0x0E vs 0x4E separation** | `glk_status` (0x0E), `glk_sleep_stage` (0x4E), `sleep_stage` (bridge-derived) — never merged. Verified in DB. |
| **Body movement** | BCG signal amplitude confirmed (avg 164.7 during snoring, 0 during quiet in-bed). Awaiting protocol doc V1.0.2.3 to formally confirm. |
| **Write volume** | 5-sec batch cycle. 2.6 MB raw / 808 POSTs per night. ~39 MB/day across 15 homes. |
| **Raw frame capture** | `20260910_332014813081.bin` (2.6 MB). All frame types logged. |

### Key Finding — 0x4E Sleep Stage Needs Device Configuration

The full-night capture shows the local TCP stream produces very limited sleep stage data:

| 0x4E Sleep Stage | Records | When |
|---|---|---|
| null (no data) | 738 | First ~5 hours on pad |
| invalid | 31 | Out-of-bed transitions |
| awake | 39 | After ~5 hours |
| deep, light, rem | 0 | Not produced |

The device can classify REM (confirmed via Byte 11 = 5 in an earlier test), but the current configuration is not producing per-minute light/deep/REM through local TCP.

**We need the GLK team's help to configure the device for per-minute sleep stage data.** Draft mail for forwarding is in Part D below.

**Currently storing:** bed presence (working), HR/RR (logging), body movement (logging, awaiting doc), 0x4E stages (logging, continuing nightly).

---

## PART D — MAIL FOR GLK TEAM (FOR FORWARDING)

**Subject: GLK AI Smart Sleep Monitor — Device Configuration for Per-Minute Sleep Stage via Local TCP**

Dear GLK Technical Team,

We are integrating the GLK AI Smart Sleep Monitor (WiFi-compact) into our elderly care platform via local TCP on port 8766. We are successfully receiving both 0x0E (realtime vitals) and 0x4E (sleep stage) frames.

**Working:**
- 0x0E: HR, RR, body movement, occupancy — arriving at ~1/sec, all correct.
- 0x4E: Arriving at 1/min. Bridge ACKs correctly — 1,170 consecutive frames overnight, zero disconnects.

**Issue:**
The 0x4E frames do not contain per-minute sleep stage classifications for most of the session:
- First ~5 hours: sleep stage byte is null/empty
- After ~5 hours: reports "awake" only
- Light, deep, REM: not observed (though we confirmed the device can classify REM — byte 11 = 5 in an earlier test)

**Request:**
1. **Device configuration or firmware setting** to enable per-minute sleep stage classification (awake/light/deep/REM) in the 0x4E frames via local TCP.
2. **Protocol document V1.0.2.3** — to confirm body movement byte mapping (Byte 8 of 0x0E) and sleep stage configuration parameters.
3. **Warm-up period guidance** — is the ~5 hour delay before classification begins expected? Can it be reduced?

**Device:** GLK AI Smart Sleep Monitor (WiFi-compact) · Local TCP port 8766 · Raspberry Pi 4 bridge, Python 3.11 · Serial: 332014813081

**Context:** Production elderly care platform. Per-minute sleep stage data through local TCP is a core requirement. All other data streams work correctly — only sleep stage classification needs configuration.

We can provide raw frame captures or packet traces if needed.

Best regards,
Manu Rajendra

---

## PART E — SENSOR OBSERVATION: FALSE OUT-OF-BED READINGS

During the Sep 10 analysis, we found two extended periods (~59 min each) where the GLK sensor reported `out_of_bed` status. However, **the person confirmed they were actually in bed during both windows**. This means the sensor was giving false out-of-bed readings while the person was still lying on the pad.

**What we observed in the DB:**
- During these "out-of-bed" periods, the sensor still logged restless flags and body movement values — which is consistent with someone being on the pad but the sensor misclassifying their status.
- HR and RR dropped to 0 because the sensor's out-of-bed classification suppresses vital readings.

**Likely cause:** Sensor pad placement or sensitivity. If the person shifts to the edge of the bed or the pad is not centered under the torso, the sensor can lose body contact detection while the person is still in bed.

**Recommended action:**
1. **Check sensor pad placement** — the pad should be centered under the chest/torso area, not shifted toward the legs or edge of the bed.
2. **Check if the pad is under a thick mattress topper** — too much material between the person and the sensor can weaken signal detection.
3. We will continue monitoring over the next few nights to see if this pattern repeats after any pad adjustment.

This is a hardware/placement issue, not a software bug. The backend correctly reflects what the sensor reports — the sensor itself needs better positioning.

---

## SUMMARY

| Item | Status |
|---|---|
| Snoring > Sleep time | Fixed — deployed |
| Low HR notification | Working correctly — HR genuinely dropped to 43 bpm |
| HR/RR dropping to zero | Sensor reported out-of-bed (may be false reading — see Part E) |
| Sleep session merge rule | Fixed — reduced from 60 min to 15 min, deployed |
| Vital alert thresholds | Documented — medically grounded |
| Timestamp fix | Fixed, verified overnight |
| 0x4E ACK loop | Confirmed (1,170 frames, zero drops) |
| 0x0E / 0x4E stored separately | Confirmed |
| Body movement (BCG) | Confirmed — awaiting protocol doc V1.0.2.3 |
| Sleep stages (light/deep/REM) | Need GLK device configuration |
| False out-of-bed readings | Sensor pad placement issue — needs physical check |
| Raw frame logging | Capturing (2.6 MB/night) |

**Next steps — need your input:**
1. **Forward the GLK team mail** (Part D) — for device configuration for per-minute sleep stage data
2. **Protocol doc V1.0.2.3** — if available separately from GLK
3. **Check sensor pad placement** at the pilot home — pad should be centered under chest/torso
4. Snoring fix is deployed — please verify on the app
5. Sleep session merge fix (15 min) — deployed

Best regards,
Backend Team
