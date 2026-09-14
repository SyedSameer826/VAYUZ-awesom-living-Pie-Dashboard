#!/usr/bin/env python3
"""
bp_bridge.py  v15 — A&D UA-656BLE BLE bridge daemon.

Based on A&D's reference implementation (ad_bridge.py) and the official
A&D BLE specification for the UA-656BLE.

Protocol (push, NOT poll):
    - After each measurement the cuff advertises for ~60 s as
      "A&D_UA-656BLE_xxxxxx".
    - This bridge runs a continuous BLE scanner. On sighting the cuff,
      it connects and MUST, within ~5 seconds of encryption:
        (a) write Date Time (0x2A08)
        (b) enable indications on Blood Pressure Measurement (0x2A35)
    - The cuff then sends all buffered measurements as indications
      (oldest first) and disconnects itself when done.
    - If the 5-second window is missed, readings are stored in the cuff's
      buffer (up to 200 if configured via ad_pair.py) and sent on the
      next successful connection.

Data pipeline:
    A&D UA-656BLE ──BLE──> This bridge ──HTTP──> Pi server.js (/api/bp/reading)
                                                        │
                                                        v
                                               Cloud backend (/api/bp/log)

v15 changes (complete rewrite from A&D reference code):
    - Replaced complex subprocess architecture with A&D's proven
      single-process scanner-connect-read loop.
    - Removed bluetoothctl scan — uses pure Bleak BleakScanner.
    - Removed ghost connection cleanup, adapter reset, hciconfig calls.
    - Added offline queue: readings persist to disk when backend is down,
      flushed oldest-first on each successful connection.
    - Added DateTime write on every connection (A&D spec requires it).
    - Added NaN marker filter (SFLOAT 2047 = 0x07FF).
    - No disconnected_callback — uses timeout to detect end of data.

Run with pm2:
    pm2 start bp_bridge.py --name bp-bridge --interpreter python3

Environment variables:
    BP_BACKEND_URL     — local Pi backend URL (default: http://localhost:4000)
    HUB_SECRET_KEY     — shared secret for Pi -> cloud auth
    BP_LOG_LEVEL       — DEBUG/INFO/WARNING (default: INFO)
    BP_COOLDOWN        — seconds before re-reading same device (default: 60)
    BP_QUEUE_DIR       — offline queue directory (default: ~/awesomliving-data/bp-queue)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import pathlib
import signal
import struct
import sys
import time
from datetime import datetime, timezone, timedelta
from urllib.request import Request, urlopen
from urllib.error import URLError

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
LOCAL_BACKEND_URL = os.environ.get("BP_BACKEND_URL", "http://localhost:4000")
READING_ENDPOINT = LOCAL_BACKEND_URL.rstrip("/") + "/api/bp/reading"
SECRET_KEY = os.environ.get("HUB_SECRET_KEY", "jwt_secret_of_awesomliving_app")
LOG_LEVEL = os.environ.get("BP_LOG_LEVEL", "INFO").upper()
COOLDOWN = int(os.environ.get("BP_COOLDOWN", "60"))
QUEUE_DIR = pathlib.Path(os.environ.get(
    "BP_QUEUE_DIR",
    os.path.join(os.path.expanduser("~"), "awesomliving-data", "bp-queue"),
))

# Path to the local device store (same as deviceStore.js uses)
DEVICES_PATH = os.environ.get(
    "DEVICES_FILE",
    os.path.join(os.path.expanduser("~"), "awesomliving-data", "devices.json"),
)

# A&D device name prefix
DEVICE_NAME_PREFIX = "A&D_UA-656BLE"

# BLE UUIDs
BP_SERVICE_UUID = "00001810-0000-1000-8000-00805f9b34fb"
BPM_CHAR = "00002a35-0000-1000-8000-00805f9b34fb"   # Blood Pressure Measurement
DATETIME_CHAR = "00002a08-0000-1000-8000-00805f9b34fb"  # Date Time (R/W)
BATTERY_CHAR = "00002a19-0000-1000-8000-00805f9b34fb"   # Battery Level

# IST timezone for measured_at timestamps
IST = timezone(timedelta(hours=5, minutes=30))

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s [bp-bridge] %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("bp-bridge")


# ---------------------------------------------------------------------------
# IEEE 11073-20601 SFLOAT decoder
# ---------------------------------------------------------------------------
def decode_sfloat(b0: int, b1: int) -> float:
    """IEEE-11073 16-bit SFLOAT, little endian bytes b0 (LSB) b1 (MSB)."""
    raw = b0 | (b1 << 8)
    # NaN, NRes, +INF, -INF, Reserved
    if raw in (0x07FF, 0x0800, 0x07FE, 0x0802, 0x0801):
        return float("nan")
    mant = raw & 0x0FFF
    if mant >= 0x0800:
        mant -= 0x1000
    exp = raw >> 12
    if exp >= 0x8:
        exp -= 0x10
    return mant * (10 ** exp)


# ---------------------------------------------------------------------------
# Parse Blood Pressure Measurement (0x2A35) per A&D spec section 2.1.1
# ---------------------------------------------------------------------------
def parse_bpm(data: bytes) -> dict | None:
    """Parse a BPM indication payload. Returns None for NaN/error frames."""
    if len(data) < 7:
        return None

    flags = data[0]
    unit_kpa = flags & 0x01
    has_ts = flags & 0x02
    has_pulse = flags & 0x04
    has_uid = flags & 0x08
    has_status = flags & 0x10

    i = 1
    sys_v = decode_sfloat(data[i], data[i + 1])
    dia_v = decode_sfloat(data[i + 2], data[i + 3])
    map_v = decode_sfloat(data[i + 4], data[i + 5])
    i += 6

    # Filter NaN marker frames (SFLOAT 2047 = cuff header before real data)
    import math
    if math.isnan(sys_v) and math.isnan(dia_v) and math.isnan(map_v):
        log.debug("NaN marker frame — skipped")
        return None

    # Convert kPa -> mmHg if needed
    if unit_kpa:
        k = 7.50062
        sys_v, dia_v, map_v = sys_v * k, dia_v * k, map_v * k

    # Measurement error check (sys=0xFF07 per A&D convention)
    if (data[1], data[2]) == (0xFF, 0x07):
        log.warning("Device reported measurement error frame — skipped")
        return None

    ts = None
    if has_ts and len(data) >= i + 7:
        year = data[i] | (data[i + 1] << 8)
        month, day, hour, minute, sec = data[i + 2:i + 7]
        i += 7
        if year and month and day:
            try:
                ts = datetime(year, month, day, hour, minute, sec)
            except (ValueError, OverflowError):
                ts = None

    pulse = None
    if has_pulse and len(data) >= i + 2:
        pulse = decode_sfloat(data[i], data[i + 1])
        if math.isnan(pulse):
            pulse = None
        i += 2

    if has_uid and len(data) >= i + 1:
        i += 1  # skip user_id byte

    irregular_heartbeat = False
    if has_status and len(data) >= i + 2:
        status_bits = data[i] | (data[i + 1] << 8)
        irregular_heartbeat = bool(status_bits & 0x0004)

    return {
        "systolic": round(sys_v) if not math.isnan(sys_v) else None,
        "diastolic": round(dia_v) if not math.isnan(dia_v) else None,
        "mean_arterial_pressure": round(map_v) if not math.isnan(map_v) else None,
        "pulse_rate": round(pulse) if pulse is not None else None,
        "measured_at": ts.isoformat() if ts else None,
        "unit": "mmHg",
        "irregular_heartbeat": irregular_heartbeat,
    }


def datetime_payload() -> bytes:
    """Date Time (0x2A08): year uint16 LE, month, day, hour, min, sec."""
    now = datetime.now()
    return struct.pack("<HBBBBB", now.year, now.month, now.day,
                       now.hour, now.minute, now.second)


# ---------------------------------------------------------------------------
# Read paired BP devices from the local device store
# ---------------------------------------------------------------------------
def get_paired_bp_devices() -> list[dict]:
    """Read devices.json and return only BP monitor entries."""
    try:
        with open(DEVICES_PATH, "r") as f:
            devices = json.load(f)
        if not isinstance(devices, list):
            return []
        return [
            d for d in devices
            if d.get("type") == "bp_monitor" and d.get("status") == "mapped"
        ]
    except (FileNotFoundError, json.JSONDecodeError) as e:
        log.warning("Could not read devices.json: %s", e)
        return []


# ---------------------------------------------------------------------------
# Backend HTTP POST
# ---------------------------------------------------------------------------
def post_reading(mac_address: str, reading: dict) -> bool:
    """POST a BP reading to the Pi's local backend."""
    payload = json.dumps({
        "mac_address": mac_address,
        "secret_key": SECRET_KEY,
        "systolic": reading.get("systolic"),
        "diastolic": reading.get("diastolic"),
        "pulse_rate": reading.get("pulse_rate"),
        "mean_arterial_pressure": reading.get("mean_arterial_pressure"),
        "unit": reading.get("unit", "mmHg"),
        "measured_at": reading.get("measured_at"),
        "irregular_heartbeat": reading.get("irregular_heartbeat", False),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }).encode("utf-8")

    req = Request(
        READING_ENDPOINT,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(req, timeout=10) as resp:
            ok = 200 <= resp.status < 300
            if ok:
                log.info("  -> reading forwarded to backend (status %d)", resp.status)
            else:
                log.warning("  -> backend returned status %d", resp.status)
            return ok
    except (URLError, OSError) as e:
        log.warning("Backend POST failed: %s", e)
        return False


# ---------------------------------------------------------------------------
# Offline queue — disk persistence when backend is down
# ---------------------------------------------------------------------------
def queue_reading(mac_address: str, reading: dict):
    """Save a reading to the disk queue for later retry."""
    QUEUE_DIR.mkdir(parents=True, exist_ok=True)
    ts = (reading.get("measured_at") or
          datetime.now().strftime("%Y%m%dT%H%M%S"))
    # Use timestamp + mac for a unique filename
    safe_ts = str(ts).replace(":", "").replace("-", "")[:15]
    safe_mac = mac_address.replace(":", "")
    fname = f"{safe_ts}_{safe_mac}.json"
    (QUEUE_DIR / fname).write_text(json.dumps({
        "mac_address": mac_address,
        **reading,
    }, default=str))
    log.info("  -> reading queued to disk: %s", fname)


def flush_queue():
    """Retry queued readings oldest-first. Stop on first failure."""
    if not QUEUE_DIR.is_dir():
        return
    queued = sorted(QUEUE_DIR.glob("*.json"))
    if not queued:
        return
    log.info("Flushing offline queue (%d pending) ...", len(queued))
    for f in queued:
        try:
            data = json.loads(f.read_text())
        except (json.JSONDecodeError, OSError):
            log.warning("Corrupt queue file %s — removing", f.name)
            f.unlink(missing_ok=True)
            continue
        mac = data.pop("mac_address", "unknown")
        if post_reading(mac, data):
            f.unlink(missing_ok=True)
        else:
            log.info("Queue flush stopped — backend still unreachable")
            break


# ---------------------------------------------------------------------------
# BLE session — one connection cycle (based on A&D ad_bridge.py)
# ---------------------------------------------------------------------------
async def handle_device(mac_address: str, device):
    """Connect to cuff, sync time, receive all buffered readings.

    Per the A&D spec, after encryption we have ~5 seconds to:
    1. Write DateTime to 0x2A08
    2. Enable indications on BPM 0x2A35 (CCCD -> 0x0002)

    The cuff then sends all stored readings as indications, oldest first,
    then disconnects itself after a 5-second idle timeout.

    We do NOT use disconnected_callback — the integration doc warns it
    fires repeatedly from background threads with this cuff on Bleak 3.x.
    Instead we use a simple timeout: after receiving at least one reading,
    if 8 seconds pass with no new indication, we assume the cuff is done.
    """
    from bleak import BleakClient

    received = []
    last_indication_time = [0.0]

    def on_indication(_char, data: bytearray):
        try:
            rec = parse_bpm(bytes(data))
            if rec is None:
                return  # NaN marker or error frame — skip
            if rec.get("systolic") is None:
                return
            received.append(rec)
            last_indication_time[0] = time.monotonic()
            log.info("  reading: %s/%s pulse=%s at %s",
                     rec["systolic"], rec["diastolic"],
                     rec["pulse_rate"], rec["measured_at"])
        except Exception:
            log.exception("Failed to parse indication: %s", data.hex())

    try:
        async with BleakClient(device, timeout=10.0) as client:
            # ---- 5-second window: time write + CCCD ----
            # DateTime FIRST (device requires sync every connection)
            await client.write_gatt_char(
                DATETIME_CHAR, datetime_payload(), response=True)
            log.info("  DateTime synced")

            # Enable indications on BPM characteristic
            await client.start_notify(BPM_CHAR, on_indication)
            log.info("  indications enabled — awaiting data")

            # ---- Wait for readings ----
            # The cuff sends buffered data then idles for 5s before
            # disconnecting. We use a timeout-based approach:
            # - Wait up to 30s total
            # - After first reading, wait up to 8s of silence = done
            start = time.monotonic()
            last_indication_time[0] = start
            while (time.monotonic() - start) < 30.0:
                await asyncio.sleep(0.5)
                if received and (time.monotonic() - last_indication_time[0]) > 8.0:
                    log.info("  8s silence after %d reading(s) — session done",
                             len(received))
                    break

            # Try to cleanly stop notifications
            try:
                await client.stop_notify(BPM_CHAR)
            except Exception:
                pass

    except Exception as e:
        log.warning("BLE session failed: %s", e)

    # ---- Forward readings ----
    log.info("=== %d reading(s) received from %s ===", len(received), mac_address)
    for rec in received:
        if not post_reading(mac_address, rec):
            queue_reading(mac_address, rec)


# ---------------------------------------------------------------------------
# Main scanner loop (based on A&D ad_bridge.py)
# ---------------------------------------------------------------------------
async def scanner_loop():
    """Continuously scan for known BP monitors and handle connections.

    Uses Bleak's detection_callback for instant response when the cuff
    starts advertising. On detection:
    1. Stop scanner (free the adapter).
    2. Connect and read (handle_device).
    3. Flush offline queue.
    4. Resume scanning.
    """
    from bleak import BleakScanner

    last_read: dict[str, float] = {}

    log.info("Scanner loop started (cooldown=%ds, backend=%s)",
             COOLDOWN, READING_ENDPOINT)

    while True:
        # Get the list of known BP monitors from devices.json
        bp_devices = get_paired_bp_devices()
        if not bp_devices:
            log.debug("No paired BP monitors — sleeping 30s")
            await asyncio.sleep(30)
            continue

        known_macs = {d.get("ieee_address", "").upper() for d in bp_devices}
        known_macs.discard("")
        log.info("Scanning for %d BP monitor(s): %s",
                 len(known_macs), ", ".join(known_macs))

        # ---- Detection callback — fires instantly on advertisement ----
        found = asyncio.Queue()

        def on_detection(device, adv_data):
            name = adv_data.local_name or device.name or ""
            mac = device.address.upper()

            # Match by MAC (known device) or by name prefix
            if mac in known_macs or name.startswith(DEVICE_NAME_PREFIX):
                try:
                    found.put_nowait((mac, device))
                except asyncio.QueueFull:
                    pass

        scanner = BleakScanner(detection_callback=on_detection)
        await scanner.start()

        try:
            # Wait for a detection (blocks until cuff advertises)
            mac_address, device = await asyncio.wait_for(
                found.get(), timeout=30.0)
        except asyncio.TimeoutError:
            await scanner.stop()
            # No device seen — loop and re-check devices.json
            await asyncio.sleep(1.0)
            continue

        await scanner.stop()  # Free the adapter before connecting

        # ---- Cooldown check ----
        if time.time() - last_read.get(mac_address, 0) < COOLDOWN:
            log.info("Cooldown active for %s — skipping", mac_address)
            # Drain any duplicate sightings
            while not found.empty():
                found.get_nowait()
            await asyncio.sleep(5)
            continue

        log.info("=== BP CUFF DETECTED: %s — connecting ===", mac_address)

        await handle_device(mac_address, device)
        last_read[mac_address] = time.time()

        # Flush any queued readings while backend is reachable
        flush_queue()

        # Drain duplicate sightings from the queue
        while not found.empty():
            found.get_nowait()

        # Brief pause before resuming scan
        await asyncio.sleep(2.0)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
async def run():
    loop = asyncio.get_event_loop()
    stop = asyncio.Event()

    def _stop():
        log.info("Shutdown signal received")
        stop.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, _stop)

    scan_task = asyncio.create_task(scanner_loop())

    await stop.wait()
    scan_task.cancel()
    try:
        await scan_task
    except asyncio.CancelledError:
        pass
    log.info("BP bridge stopped")


def main():
    log.info("Starting BP bridge v15 (A&D reference pattern, backend=%s)",
             READING_ENDPOINT)
    asyncio.run(run())


if __name__ == "__main__":
    main()
