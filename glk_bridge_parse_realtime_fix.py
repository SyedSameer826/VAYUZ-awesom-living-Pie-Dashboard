"""
GLK Bridge — parse_realtime() FIX
==================================
Apply this to the running glk_bridge.py on the Raspberry Pi.

ROOT CAUSE (proven via Aug 23 production data analysis):
  The original parse_realtime() has the byte offsets shifted by 4 positions.
  Bytes 0-1 of the 0x0E realtime payload are protocol markers (constant 0x6A, 0x8A),
  NOT heart rate and respiration rate.

EVIDENCE:
  - "heart_rate" was ALWAYS 106 (0x6A) across 317 readings — real HR varies
  - "respiration_rate" was ALWAYS 138 (0x8A) — real RR varies
  - Bytes 2-3 matched wall-clock seconds 29/29 times — they're a timer, not status/movement
  - Byte 4 ranged 53-84 (avg 68.5) — matches resting heart rate perfectly
  - Byte 5 ranged 11-26 (avg 15.2) — matches normal respiration rate
  - Byte 6 had values {2,3,4,6} — maps to STATUS_MAP entries
  - When byte 6 = 4 (out_of_bed), bytes 4 and 5 were ALWAYS 0 (no contact)
  - When byte 6 = 2 (apnea), byte 5 was ALWAYS 0 (no respiration detected)

HOW TO APPLY:
  1. SSH into the Pi
  2. Find glk_bridge.py:  find / -name "glk_bridge.py" 2>/dev/null
  3. Replace the parse_realtime() function AND STATUS_MAP with the versions below
  4. Restart the bridge:  sudo systemctl restart glk-bridge
     (or kill and re-run the Python process)
"""

# ── Replace STATUS_MAP ──────────────────────────────────────────────
STATUS_MAP = {
    0: "initializing",
    1: "in_bed",
    2: "apnea_suspected",
    3: "snoring",
    4: "out_of_bed",
    5: "life_abnormality",
    6: "light_sleep",
}

# ── Replace parse_realtime() ────────────────────────────────────────
def parse_realtime(frame):
    p = frame["payload"]
    if len(p) < 11:
        return {}
    # Corrected byte layout (Aug 2026):
    # p[0:2]  = protocol markers (constant 0x6A, 0x8A) — NOT vitals
    # p[2:4]  = 16-bit BE second counter — NOT status/movement
    # p[4]    = heart rate (bpm, 0 = no contact / out of bed)
    # p[5]    = respiration rate (brpm, 0 = no contact / apnea)
    # p[6]    = status code (0-5 per STATUS_MAP)
    # p[7]    = battery level (percentage, often 100)
    # p[8]    = reserved (usually 0)
    # p[9]    = signal quality (usually 100)
    # p[10]   = body movement intensity (0-255)
    sc = p[6]
    IN_BED_STATUSES = {1, 2, 3, 5, 6}  # everything except 0 (init) and 4 (out_of_bed)
    return {
        "heart_rate": p[4] if p[4] != 0xFF else None,
        "respiration_rate": p[5] if p[5] != 0xFF else None,
        "status_code": sc,
        "status": STATUS_MAP.get(sc, f"unknown_{sc}"),
        "in_bed": sc in IN_BED_STATUSES,
        "out_of_bed": sc == 4,
        "apnea_suspected": sc == 2,
        "snoring": sc == 3,
        "body_movement": p[10] if len(p) > 10 else 0,
        "battery_level": p[7] if len(p) > 7 else None,
        "life_abnormality": sc == 5,
        "timer_counter": (p[2] << 8) | p[3],
    }
