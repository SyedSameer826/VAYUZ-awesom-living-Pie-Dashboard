#!/usr/bin/env python3
"""
bp_bridge.py — BLE bridge for Bluetooth Blood Pressure monitors.

Continuously scans for known (paired) BP monitors. The instant a monitor
starts advertising (user pressed its Bluetooth button after taking a
reading), the bridge connects, reads any pending Blood Pressure Measurement
indications (characteristic 0x2A35), parses IEEE 11073-20601 SFLOAT values,
and forwards readings to the Pi's local backend (which relays to the cloud).

Architecture:
    BP monitor ──BLE──▶  This bridge  ──HTTP──▶  Pi server.js (/api/bp/reading)
                                                       │
                                                       ▼
                                              Cloud backend (/api/bp/log)

The bridge runs as a pm2 service. It keeps a BLE scanner active at all
times, reacting within seconds when a BP monitor advertises — no polling
delay. After reading from a device, a 60-second cooldown prevents
re-reading the same advertisement burst.

A&D UA-656BLE behaviour:
    - User takes a reading with the cuff
    - Reading is stored in device memory (up to ~60 readings)
    - User presses the Bluetooth button → device advertises for ~30s
    - A BLE central that connects and subscribes to 0x2A35 receives ALL
      stored (unsent) readings as indications, one per reading
    - After successful transfer the device clears its "unsent" flag

Run with pm2:
    pm2 start bp_bridge.py --name bp-bridge --interpreter python3

Environment variables:
    BP_READ_TIMEOUT    — seconds to wait for indications per device (default: 30)
    BP_BACKEND_URL     — local Pi backend URL (default: http://localhost:4000)
    HUB_SECRET_KEY     — shared secret for Pi → cloud auth
    BP_LOG_LEVEL       — DEBUG/INFO/WARNING (default: INFO)
    BP_COOLDOWN        — seconds before re-reading same device (default: 60)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import struct
import subprocess
import sys
import time
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.error import URLError

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
READ_TIMEOUT = int(os.environ.get("BP_READ_TIMEOUT", "30"))
LOCAL_BACKEND_URL = os.environ.get("BP_BACKEND_URL", "http://localhost:4000")
READING_ENDPOINT = LOCAL_BACKEND_URL.rstrip("/") + "/api/bp/reading"
SECRET_KEY = os.environ.get("HUB_SECRET_KEY", "jwt_secret_of_awesomliving_app")
LOG_LEVEL = os.environ.get("BP_LOG_LEVEL", "INFO").upper()
COOLDOWN = int(os.environ.get("BP_COOLDOWN", "60"))

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
    if raw in (0x07FF, 0x0800, 0x07FE, 0x0802, 0x0801):
        return None

    exponent = raw >> 12
    if exponent >= 8:
        exponent -= 16

    mantissa = raw & 0x0FFF
    if mantissa >= 0x0800:
        mantissa -= 0x1000

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
    unit_kpa = bool(flags & 0x01)
    has_timestamp = bool(flags & 0x02)
    has_pulse = bool(flags & 0x04)
    has_user_id = bool(flags & 0x08)
    has_status = bool(flags & 0x10)

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

    if has_pulse and len(data) >= offset + 2:
        pulse_raw = struct.unpack_from("<H", data, offset)[0]
        pulse = decode_sfloat(pulse_raw)
        result["pulse_rate"] = round(pulse, 1) if pulse is not None else None
        offset += 2

    if has_user_id and len(data) >= offset + 1:
        result["user_id"] = data[offset]
        offset += 1

    if has_status and len(data) >= offset + 2:
        status_bits = struct.unpack_from("<H", data, offset)[0]
        result["irregular_heartbeat"] = bool(status_bits & 0x0004)
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
# BlueZ cache cleanup — clear stale D-Bus state that blocks BLE connects
# ---------------------------------------------------------------------------
def _remove_cached_device(address: str):
    """Remove a cached/stale BLE device from BlueZ so the next connect is fresh."""
    try:
        log.debug("Removing cached device %s from BlueZ ...", address)
        subprocess.run(
            ["bluetoothctl", "remove", address],
            capture_output=True, timeout=5, text=True, check=False,
        )
    except Exception as e:
        log.debug("  remove cached device (non-fatal): %s", e)


def _trust_device(address: str):
    """Trust device via bluetoothctl so BlueZ allows future connections."""
    try:
        subprocess.run(
            ["bluetoothctl", "trust", address],
            capture_output=True, timeout=5, text=True, check=False,
        )
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Connect to a BP device, read indications, forward readings
# ---------------------------------------------------------------------------
BLE_CONNECT_RETRIES = 3

async def read_device_ble(address: str) -> int:
    """Connect to a detected BP monitor, read indications, forward readings.

    Mirrors bp_provision.py's proven approach:
      1. Clear BlueZ cache (removes stale D-Bus objects)
      2. Fresh targeted scan to re-discover device (re-registers in BlueZ)
      3. Connect with the fresh BLEDevice + retries
      4. Read BP measurement indications
      5. Forward readings to backend

    Returns the number of readings successfully forwarded.
    """
    from bleak import BleakScanner, BleakClient

    address = address.upper()
    log.info("=== BP READ START for %s ===", address)

    # Step 0: Clear stale BlueZ cache — previous pair/connect attempts leave
    # D-Bus objects that cause connect() to hang for 15s then timeout.
    # We MUST re-scan after this to get a fresh BLEDevice reference.
    _remove_cached_device(address)

    # Step 1: Fresh targeted scan — re-discover the device so BlueZ has a
    # clean D-Bus entry. The monitor should still be advertising (30s window).
    ble_device = None
    found_event = asyncio.Event()

    def _on_detect(device, adv_data):
        nonlocal ble_device
        if device.address.upper() == address:
            ble_device = device
            log.info("  Re-discovered %s (RSSI=%s)", address, adv_data.rssi)
            found_event.set()

    rescan_timeout = 10.0
    log.info("  Re-scanning for %s after cache clear (%ds) ...", address, rescan_timeout)
    scanner = BleakScanner(detection_callback=_on_detect)
    await scanner.start()
    try:
        await asyncio.wait_for(found_event.wait(), timeout=rescan_timeout)
    except asyncio.TimeoutError:
        log.warning("  %s did not re-advertise in %ds", address, rescan_timeout)
    finally:
        await scanner.stop()

    if ble_device is None:
        log.info("=== BP READ DONE for %s: 0 collected (device gone after cache clear) ===",
                 address)
        return 0

    # Step 2: Connect with retries using the fresh BLEDevice
    readings: list[dict] = []

    def on_indicate(_char, data: bytearray):
        """Called when the device sends a BP measurement indication."""
        log.info("  BP indication: %d bytes: %s", len(data), data.hex())
        reading = parse_bp_measurement(bytes(data))
        if reading and reading.get("systolic") is not None:
            readings.append(reading)
            log.info("  Parsed: sys=%s dia=%s pulse=%s",
                     reading.get("systolic"),
                     reading.get("diastolic"),
                     reading.get("pulse_rate"))

    client = None
    last_err = None
    for attempt in range(1, BLE_CONNECT_RETRIES + 1):
        try:
            log.info("  Connect attempt %d/%d to %s ...",
                     attempt, BLE_CONNECT_RETRIES, address)
            client = BleakClient(ble_device, timeout=15.0)
            await client.connect()
            if not client.is_connected:
                raise RuntimeError("connect() succeeded but is_connected=False")
            log.info("  CONNECTED to %s on attempt %d", address, attempt)
            last_err = None
            break
        except Exception as e:
            last_err = e
            log.warning("  Connect attempt %d FAILED: %s: %s",
                        attempt, type(e).__name__, e)
            try:
                await client.disconnect()
            except Exception:
                pass
            client = None
            if attempt < BLE_CONNECT_RETRIES:
                _remove_cached_device(address)
                await asyncio.sleep(1.0)

    if last_err is not None:
        log.warning("  All %d connect attempts failed for %s",
                    BLE_CONNECT_RETRIES, address)
        log.info("=== BP READ DONE for %s: 0 collected, 0 forwarded (connect failed) ===",
                 address)
        return 0

    # Step 3: Re-trust so BlueZ allows future connections
    _trust_device(address)

    # Step 4: Read indications
    try:
        # Find the BP Measurement characteristic
        bp_char = None
        for service in client.services:
            for char in service.characteristics:
                if BP_MEASUREMENT_CHAR.lower() in char.uuid.lower():
                    bp_char = char
                    break

        if not bp_char:
            log.warning("  BP Measurement characteristic (0x2A35) not found on %s", address)
            return 0

        # Subscribe to indications — device sends stored readings immediately
        log.info("  Subscribing to BP indications on %s ...", bp_char.uuid)
        await client.start_notify(bp_char.uuid, on_indicate)

        # Wait for indications
        elapsed = 0.0
        while elapsed < READ_TIMEOUT:
            await asyncio.sleep(0.5)
            elapsed += 0.5
            # Once we have at least one reading, wait 5 more seconds for extras
            if readings and elapsed > 5.0:
                remaining_wait = min(5.0, READ_TIMEOUT - elapsed)
                await asyncio.sleep(remaining_wait)
                break

        log.info("  Indication wait done — got %d reading(s)", len(readings))

        try:
            await client.stop_notify(bp_char.uuid)
        except Exception:
            pass

    except Exception as e:
        log.warning("  BLE error with %s: %s: %s", address, type(e).__name__, e)
    finally:
        if client:
            try:
                await client.disconnect()
                log.info("  Disconnected from %s", address)
            except Exception:
                pass

    # Forward all collected readings
    forwarded = 0
    for reading in readings:
        if forward_reading(address, reading):
            forwarded += 1

    log.info("=== BP READ DONE for %s: %d collected, %d forwarded ===",
             address, len(readings), forwarded)
    return forwarded


# ---------------------------------------------------------------------------
# Main scanner loop — event-driven, reacts instantly to advertisements
# ---------------------------------------------------------------------------
async def scanner_loop():
    """Continuously scan for known BP monitors and read when detected.

    Instead of polling every N minutes (which misses the ~30s advertising
    window), this keeps a BLE scanner active at all times. The instant a
    known BP monitor starts advertising, the bridge connects and reads.

    A per-device cooldown prevents re-reading the same advertisement burst.
    """
    from bleak import BleakScanner

    last_read: dict[str, float] = {}  # MAC → timestamp of last read
    log.info("Scanner loop started (read_timeout=%ds, cooldown=%ds)", READ_TIMEOUT, COOLDOWN)

    while True:
        # Refresh known devices each scan cycle
        bp_devices = get_paired_bp_devices()
        if not bp_devices:
            log.debug("No paired BP monitors, sleeping 30s ...")
            await asyncio.sleep(30)
            continue

        known_macs = {d.get("ieee_address", "").upper() for d in bp_devices}
        known_macs.discard("")
        log.info("Scanning for %d BP monitor(s): %s", len(known_macs), ", ".join(known_macs))

        detected_device = None
        found_event = asyncio.Event()

        def _on_detect(device, adv_data):
            nonlocal detected_device
            mac = device.address.upper()
            if mac not in known_macs:
                return
            # Check cooldown
            last = last_read.get(mac, 0)
            if time.time() - last < COOLDOWN:
                return
            detected_device = device
            log.info("BP MONITOR DETECTED: %s (name=%s, RSSI=%s)",
                     mac, device.name or "?", adv_data.rssi)
            found_event.set()

        scanner = BleakScanner(detection_callback=_on_detect)

        try:
            await scanner.start()

            # Scan for up to 60 seconds, then refresh device list
            try:
                await asyncio.wait_for(found_event.wait(), timeout=60.0)
            except asyncio.TimeoutError:
                pass  # No device detected this cycle — loop and refresh

            await scanner.stop()

        except Exception as e:
            log.warning("Scanner error: %s", e)
            try:
                await scanner.stop()
            except Exception:
                pass
            await asyncio.sleep(5)
            continue

        if detected_device:
            count = await read_device_ble(detected_device.address)
            if count > 0:
                last_read[detected_device.address.upper()] = time.time()
                log.info("Cooldown active for %s (%ds)",
                         detected_device.address, COOLDOWN)
            # Brief pause before resuming scan
            await asyncio.sleep(2.0)
        else:
            # No detection — brief pause before next scan cycle
            await asyncio.sleep(1.0)


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
    log.info("Starting BP bridge v4 (cache-clear + re-scan + connect, backend=%s)",
             READING_ENDPOINT)
    asyncio.run(run())


if __name__ == "__main__":
    main()
