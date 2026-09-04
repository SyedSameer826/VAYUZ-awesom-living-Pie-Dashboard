#!/usr/bin/env python3
"""
bp_bridge.py — BLE bridge for Bluetooth Blood Pressure monitors.

Periodically connects to bonded BP monitors, reads any pending Blood Pressure
Measurement indications (characteristic 0x2A35), parses IEEE 11073-20601
SFLOAT values, and forwards readings to the Pi's local backend (which relays
to the cloud).

Architecture:
    BP monitor ──BLE──▶  This bridge  ──HTTP──▶  Pi server.js (/api/bp/reading)
                                                       │
                                                       ▼
                                              Cloud backend (/api/bp/log)

The bridge runs as a systemd service alongside glk_bridge.py. It wakes up
every POLL_INTERVAL seconds, iterates over all paired BP devices from the
local device store, connects to each, enables indications on 0x2A35, waits
for readings, and forwards them.

Run as a systemd service:
    [Service]
    ExecStart=/usr/bin/python3 /home/pi/VAYUZ-awesom-living-Pie-Dashboard/bp_bridge.py
    Restart=always

Environment variables:
    BP_POLL_INTERVAL   — seconds between poll cycles (default: 300 = 5 min)
    BP_READ_TIMEOUT    — seconds to wait for indications per device (default: 30)
    BP_BACKEND_URL     — local Pi backend URL (default: http://localhost:4000)
    HUB_SECRET_KEY     — shared secret for Pi → cloud auth
    BP_LOG_LEVEL       — DEBUG/INFO/WARNING (default: INFO)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import struct
import sys
import time
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.error import URLError

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
POLL_INTERVAL = int(os.environ.get("BP_POLL_INTERVAL", "300"))  # 5 min default
READ_TIMEOUT = int(os.environ.get("BP_READ_TIMEOUT", "30"))     # 30s per device
LOCAL_BACKEND_URL = os.environ.get("BP_BACKEND_URL", "http://localhost:4000")
READING_ENDPOINT = LOCAL_BACKEND_URL.rstrip("/") + "/api/bp/reading"
SECRET_KEY = os.environ.get("HUB_SECRET_KEY", "jwt_secret_of_awesomliving_app")
LOG_LEVEL = os.environ.get("BP_LOG_LEVEL", "INFO").upper()

# Path to the local device store (same as deviceStore.js uses)
DEVICES_PATH = os.environ.get(
    "DEVICES_FILE",
    os.path.join(os.path.expanduser("~"), "awesomliving-data", "devices.json"),
)

# Blood Pressure Service UUID (0x1810)
BP_SERVICE_UUID = "00001810-0000-1000-8000-00805f9b34fb"
# Blood Pressure Measurement characteristic (0x2A35) — indicate
BP_MEASUREMENT_CHAR = "00002a35-0000-1000-8000-00805f9b34fb"

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s [bp-bridge] %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("bp-bridge")


# ---------------------------------------------------------------------------
# IEEE 11073-20601 SFLOAT decoder
# ---------------------------------------------------------------------------
def decode_sfloat(raw: int) -> float | None:
    """Decode a 16-bit IEEE 11073-20601 SFLOAT value.

    Layout: [exponent: 4 bits signed] [mantissa: 12 bits signed]

    Special values (NaN, NRes, +INF, -INF, Reserved) return None.
    """
    # Special values per IEEE 11073-20601
    if raw in (0x07FF, 0x0800, 0x07FE, 0x0802, 0x0801):
        return None

    # Extract exponent (high 4 bits, signed) and mantissa (low 12 bits, signed)
    exponent = raw >> 12
    if exponent >= 8:
        exponent -= 16  # sign-extend 4-bit

    mantissa = raw & 0x0FFF
    if mantissa >= 0x0800:
        mantissa -= 0x1000  # sign-extend 12-bit

    return mantissa * (10.0 ** exponent)


# ---------------------------------------------------------------------------
# Parse Blood Pressure Measurement (0x2A35) indication payload
# ---------------------------------------------------------------------------
def parse_bp_measurement(data: bytes) -> dict:
    """Parse a Blood Pressure Measurement characteristic value.

    Byte layout per Bluetooth SIG GATT specification:
        [0]     flags
        [1:3]   systolic (SFLOAT, mmHg or kPa based on flags bit 0)
        [3:5]   diastolic (SFLOAT)
        [5:7]   mean_arterial_pressure (SFLOAT)
        [7:14]  timestamp (if flags bit 1 set): year(2) month day hour min sec
        [next]  pulse_rate (SFLOAT, if flags bit 2 set)
        [next]  user_id (uint8, if flags bit 3 set)
        [next]  measurement_status (uint16, if flags bit 4 set)
    """
    if len(data) < 7:
        log.warning("BP measurement too short (%d bytes)", len(data))
        return {}

    flags = data[0]
    unit_kpa = bool(flags & 0x01)           # bit 0: 0=mmHg, 1=kPa
    has_timestamp = bool(flags & 0x02)      # bit 1
    has_pulse = bool(flags & 0x04)          # bit 2
    has_user_id = bool(flags & 0x08)        # bit 3
    has_status = bool(flags & 0x10)         # bit 4

    # Systolic, diastolic, MAP — always present (bytes 1-6)
    systolic_raw = struct.unpack_from("<H", data, 1)[0]
    diastolic_raw = struct.unpack_from("<H", data, 3)[0]
    map_raw = struct.unpack_from("<H", data, 5)[0]

    systolic = decode_sfloat(systolic_raw)
    diastolic = decode_sfloat(diastolic_raw)
    mean_arterial = decode_sfloat(map_raw)

    result = {
        "systolic": round(systolic, 1) if systolic is not None else None,
        "diastolic": round(diastolic, 1) if diastolic is not None else None,
        "mean_arterial_pressure": round(mean_arterial, 1) if mean_arterial is not None else None,
        "unit": "kPa" if unit_kpa else "mmHg",
    }

    offset = 7

    # Timestamp (7 bytes: year_le16 month day hour min sec)
    if has_timestamp and len(data) >= offset + 7:
        year = struct.unpack_from("<H", data, offset)[0]
        month = data[offset + 2]
        day = data[offset + 3]
        hour = data[offset + 4]
        minute = data[offset + 5]
        second = data[offset + 6]
        try:
            result["measured_at"] = datetime(
                year, month, day, hour, minute, second
            ).isoformat()
        except (ValueError, OverflowError):
            result["measured_at"] = None
        offset += 7

    # Pulse rate (SFLOAT, 2 bytes)
    if has_pulse and len(data) >= offset + 2:
        pulse_raw = struct.unpack_from("<H", data, offset)[0]
        pulse = decode_sfloat(pulse_raw)
        result["pulse_rate"] = round(pulse, 1) if pulse is not None else None
        offset += 2

    # User ID (1 byte)
    if has_user_id and len(data) >= offset + 1:
        result["user_id"] = data[offset]
        offset += 1

    # Measurement status (2 bytes, bitfield)
    if has_status and len(data) >= offset + 2:
        status_bits = struct.unpack_from("<H", data, offset)[0]
        result["irregular_heartbeat"] = bool(status_bits & 0x0004)  # bit 2
        offset += 2

    return result


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
# Forward a reading to the Pi backend
# ---------------------------------------------------------------------------
def forward_reading(mac_address: str, reading: dict) -> bool:
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
                log.info("  Forwarded reading to backend (status %d)", resp.status)
            else:
                log.warning("  Backend returned status %d", resp.status)
            return ok
    except (URLError, OSError) as e:
        log.warning("Backend POST failed: %s", e)
        return False


# ---------------------------------------------------------------------------
# Connect to one BP device and read measurements
# ---------------------------------------------------------------------------
async def read_device(device: dict) -> int:
    """Connect to a BP monitor, read indications, forward readings.

    Returns the number of readings successfully forwarded.
    """
    from bleak import BleakClient

    address = device.get("ieee_address", "")
    if not address:
        return 0

    log.info("Connecting to BP monitor %s ...", address)

    readings = []
    done_event = asyncio.Event()

    def on_indicate(_char, data: bytearray):
        """Called when the device sends a BP measurement indication."""
        log.info("  BP indication from %s: %d bytes: %s",
                 address, len(data), data.hex())
        reading = parse_bp_measurement(bytes(data))
        if reading and reading.get("systolic") is not None:
            readings.append(reading)
            log.info("  Parsed: sys=%s dia=%s pulse=%s",
                     reading.get("systolic"),
                     reading.get("diastolic"),
                     reading.get("pulse_rate"))

    client = None
    try:
        client = BleakClient(address, timeout=15.0)
        await client.connect()

        if not client.is_connected:
            log.warning("  Could not connect to %s", address)
            return 0

        log.info("  Connected to %s", address)

        # Check for BP Measurement characteristic
        bp_char = None
        for service in client.services:
            for char in service.characteristics:
                if BP_MEASUREMENT_CHAR.lower() in char.uuid.lower():
                    bp_char = char
                    break

        if not bp_char:
            log.warning("  BP Measurement characteristic not found on %s", address)
            return 0

        # Subscribe to indications
        log.info("  Subscribing to BP indications on %s ...", bp_char.uuid)
        await client.start_notify(bp_char.uuid, on_indicate)

        # Wait for indications (the device sends stored readings once we subscribe)
        try:
            await asyncio.wait_for(
                _wait_for_readings(readings, done_event),
                timeout=READ_TIMEOUT,
            )
        except asyncio.TimeoutError:
            log.info("  Read timeout after %ds — got %d readings", READ_TIMEOUT, len(readings))

        try:
            await client.stop_notify(bp_char.uuid)
        except Exception:
            pass

    except Exception as e:
        log.warning("  BLE error with %s: %s", address, e)
    finally:
        if client:
            try:
                await client.disconnect()
            except Exception:
                pass

    # Forward all collected readings
    forwarded = 0
    for reading in readings:
        if forward_reading(address, reading):
            forwarded += 1

    log.info("  %s: %d readings collected, %d forwarded", address, len(readings), forwarded)
    return forwarded


async def _wait_for_readings(readings: list, done: asyncio.Event):
    """Wait until we have at least one reading, then wait a bit more for any extras."""
    # Wait up to READ_TIMEOUT for first reading
    while not readings:
        await asyncio.sleep(0.5)

    # Got at least one — wait 5 more seconds for any additional stored readings
    await asyncio.sleep(5.0)


# ---------------------------------------------------------------------------
# Main poll loop
# ---------------------------------------------------------------------------
async def poll_loop():
    """Periodically poll all paired BP monitors for new readings."""
    log.info("BP bridge started (poll_interval=%ds, read_timeout=%ds)",
             POLL_INTERVAL, READ_TIMEOUT)

    while True:
        bp_devices = get_paired_bp_devices()

        if bp_devices:
            log.info("Poll cycle: %d paired BP monitor(s)", len(bp_devices))
            for device in bp_devices:
                try:
                    await read_device(device)
                except Exception as e:
                    log.warning("Error reading %s: %s",
                                device.get("ieee_address", "?"), e)
                # Small gap between devices so BlueZ settles
                await asyncio.sleep(2.0)
        else:
            log.debug("No paired BP monitors found, sleeping")

        await asyncio.sleep(POLL_INTERVAL)


# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------
async def run():
    loop = asyncio.get_event_loop()
    stop = asyncio.Event()

    def _stop():
        log.info("Shutdown signal received")
        stop.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, _stop)

    poll_task = asyncio.create_task(poll_loop())

    await stop.wait()
    poll_task.cancel()
    try:
        await poll_task
    except asyncio.CancelledError:
        pass
    log.info("BP bridge stopped")


def main():
    log.info("Starting BP bridge v1 (poll_interval=%ds, backend=%s)",
             POLL_INTERVAL, READING_ENDPOINT)
    asyncio.run(run())


if __name__ == "__main__":
    main()
