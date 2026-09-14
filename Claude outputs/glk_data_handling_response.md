# GLK Data Handling — Response (8 Sep 2026)

---

## 1. 0x0E Status vs 0x4E Sleep Stage — Already Stored Separately

These two are **never mixed**. The system treats them as completely different data streams:

- **0x0E "status" (every 5 sec):** This is the device's real-time operational state — "in bed", "snoring", "out of bed", etc. The "Light Sleep" at status=6 here is just a device state label, not a sleep architecture classification. Stored in the field `glk_status`.

- **0x4E "sleep stage" (every ~1 min):** This is the actual sleep architecture — awake, light, deep, REM. Stored in a completely separate field `glk_sleep_stage`.

Each has its own parser, its own database field, and its own status mapping. The dashboard uses only `glk_sleep_stage` for the light/deep/rem/awake breakdown chart — it never confuses 0x0E's status=6 with actual sleep staging.

**No changes needed.**

---

## 2. body_movement 237 During Snoring — Acknowledged

You're right that 237 during snoring doesn't make sense if it were a proportional "how much are they moving" index. Our real data confirms this — nearly half of all in-bed readings show values above 200, even during quiet sleep and snoring. This strongly suggests byte 10 is a **raw sensor amplitude** (snoring vibrations register as high values), not a "percentage of movement."

**What we've done:**
- The **raw 0-255 value is always stored as-is** — nothing is lost
- For display, we apply a **compressed curve** so that values up to 230 show as low activity (0-4 on a 0-10 scale), and only 230-255 shows as actual tossing/turning. So 237 during snoring displays as mild (~5.7) instead of the misleading 9.3 a straight-line scale would give
- This curve is **display-only** — it doesn't change what's stored
- **No alerts or notifications** are triggered by this field

**Pending:** We need vendor clarification on what byte 10 actually represents before building anything further on it.

---

## 3. Store Raw, Act on Almost Nothing — Already Doing This

Everything the device sends is **stored raw** in the database — heart rate, breathing rate, movement, battery, signal quality, sleep stages, raw hex frames. Nothing is thrown away.

The only field that **actively drives behavior** in the app is `in_bed` (is the person on the bed). That's it. Everything else is display-only:

- Heart rate / breathing rate → shown on the sleep screen, no alerts
- Sleep stages → shown as "sleep stages as reported by the bed sensor" — no scoring, no assessment
- Internal flags like "life abnormality" or "sleep apnea" → stored in DB but **never shown to families using those clinical terms**. Any family-facing message says something like "unusual reading from the bed sensor"

**No changes needed.**

---

## 4. Pi Write Pattern — No Per-Frame SD Card Writes

The bridge does **NOT** write data files to the SD card. All data goes out over the network as HTTP requests:

- **0x0E:** 1 HTTP request every 5 seconds → ~17,280/day
- **0x4E:** 1 HTTP request per frame (roughly per minute during sleep) → ~480/night

These go to the local Node server on the Pi and to the cloud backend — no data files are written to disk.

**The SD card wear risk is from system logs**, not from sensor data. Each forwarded reading generates 1-2 log lines on disk.

**Recommended before 15-home rollout:**
1. Reduce logging level to warnings-only in production (~95% fewer disk writes)
2. Move log directories to RAM disk (tmpfs) so they never touch the SD card
3. If we need offline data buffering, batch writes every 60 seconds to a single file instead of per-reading
4. Consider read-only SD card setup with RAM overlay — the standard approach for Pis meant to run for years

---

## 5. 0x4E ACK — Done and Running

The bridge sends the required acknowledgment immediately for every 0x4E frame it receives. Format: `82 05 00 <seq> 4E 01 <checksum>`. This has been live since the v24 bridge deployment — no device disconnection issues since.

---

## 6. REM Sleep Extraction — Done End-to-End

Fully working:
- Pi reads the sleep stage byte from 0x4E frames (code 5 = REM)
- Backend stores it in the `glk_sleep_stage` field
- Dashboard calculates duration per stage (light/deep/rem/awake)
- App shows the breakdown on the sleep detail screen

We display exactly what the device reports, with no modification.

---

| # | Concern | Status | Next Step |
|---|---------|--------|-----------|
| 1 | 0x0E vs 0x4E mixed together | Already separate | None |
| 2 | body_movement doesn't make sense | Raw stored; display uses compressed curve | Need vendor clarification on byte 10 |
| 3 | Don't act on unvalidated fields | Only in_bed drives behavior | None |
| 4 | SD card wear from per-frame writes | Data goes via HTTP, not to disk; logs are the risk | Reduce logging + RAM disk before rollout |
| 5 | 0x4E ACK | Implemented and running | None |
| 6 | REM extraction | Working end-to-end | None |
