#!/usr/bin/env python3
"""
bp_bridge.py  v14 — BLE bridge for Bluetooth Blood Pressure monitors.

Continuously scans for known (paired) BP monitors. The instant a monitor
starts advertising (user pressed its Bluetooth button after taking a
reading), the bridge spawns a **fresh subprocess** to connect, read any
pending Blood Pressure Measurement indications (characteristic 0x2A35),
and parse IEEE 11073-20601 SFLOAT values.  The parent process forwards
the readings to the Pi's local backend (which relays to the cloud).

Architecture:
    BP monitor ──BLE──▶  This bridge  ──HTTP──▶  Pi server.js (/api/bp/reading)
                                                       │
                                                       ▼
                                              Cloud backend (/api/bp/log)

Why subprocess?
    bp_provision.py (one-shot CLI) connects to the A&D UA-656BLE reliably
    every time, but the same BLE code running inside a long-lived pm2
    process fails with 15-second connect timeouts.  The root cause is
    stale BlueZ D-Bus session state that accumulates in a long-running
    process.  By spawning a fresh Python process for each read, we get a
    clean D-Bus session — the same advantage bp_provision.py has.

Two execution modes:
    Normal  (pm2):   python3 bp_bridge.py
                     → runs the event-driven scanner loop, spawns
                       subprocesses to do actual BLE reads.

    Read    (child): python3 bp_bridge.py --read <MAC_ADDRESS>
                     → one-shot: connect to the device, read indications,
                       print each reading as a JSON line to stdout, exit.

A&D UA-656BLE behaviour:
    - User takes a reading with the cuff
    - Reading is stored in device memory (up to ~60 readings)
    - User presses the Bluetooth button → device advertises for ~30s
    - A BLE central that connects and subscribes to 0x2A35 receives ALL
      stored (unsent) readings as indications, one per reading
    - After successful transfer the device clears its "unsent" flag

v14 changes — direct Bleak connect (same as bp_provision.py):
    v13 used a pexpect/bluetoothctl auto-connect strategy that ran
    'remove {address}' before every read attempt.  This DESTROYED the
    BLE bond established during provisioning, leaving the device in
    Paired: no, Bonded: no state.  Without a bond, the A&D cuff refused
    GATT service access.

    v14 fixes:
    1. NO 'remove' command — the existing bond from provisioning is
       preserved across all read attempts.
    2. Child uses BleakScanner with detection_callback to grab a fresh
       BLEDevice the instant the monitor advertises (same pattern as
       bp_provision.py).
    3. BleakClient(ble_device) direct connect — passes the live BLEDevice
       object, not a stale MAC address string.
    4. No pexpect dependency — pure Bleak for scan + connect + GATT reads.
    5. Parent scanner unchanged — real-time async bluetoothctl scan.

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

# Subprocess timeout
SUBPROCESS_TIMEOUT = 90

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
    """Decode a 16-bit IEEE 11073-20601 SFLOAT value."""
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
    """Parse a Blood Pressure Measurement characteristic value."""
    if len(data) < 7:
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


# ===================================================================
#  SUBPROCESS READ MODE  (--read <MAC>)
#  Runs in a fresh process — clean BlueZ D-Bus session every time.
# ===================================================================

# ---------------------------------------------------------------------------
# BlueZ diagnostic helpers
# ---------------------------------------------------------------------------

def _check_ghost_connections() -> list[str]:
    """Check for existing BLE connections that might block new ones."""
    try:
        result = subprocess.run(
            ["hcitool", "con"],
            capture_output=True, timeout=5, text=True, check=False,
        )
        lines = result.stdout.strip().splitlines()
        connected = []
        for line in lines:
            parts = line.strip().split()
            if len(parts) >= 3 and ":" in parts[2]:
                connected.append(parts[2].upper())
        if connected:
            print(f"  Ghost connections found: {connected}", file=sys.stderr, flush=True)
        return connected
    except Exception as e:
        print(f"  hcitool con check failed: {e}", file=sys.stderr, flush=True)
        return []


def _disconnect_device(address: str):
    """Force-disconnect a specific device via bluetoothctl."""
    try:
        subprocess.run(
            ["bluetoothctl", "disconnect", address],
            capture_output=True, timeout=5, text=True, check=False,
        )
    except Exception:
        pass


def _reset_adapter():
    """Reset the BLE adapter to clear all state."""
    print("  Resetting BLE adapter ...", file=sys.stderr, flush=True)
    try:
        r = subprocess.run(
            ["hciconfig", "hci0", "reset"],
            capture_output=True, timeout=5, text=True, check=False,
        )
        if r.returncode == 0:
            print("  Adapter reset via hciconfig", file=sys.stderr, flush=True)
            time.sleep(1.5)
        else:
            subprocess.run(["bluetoothctl", "power", "off"],
                           capture_output=True, timeout=5, check=False)
            time.sleep(0.5)
            subprocess.run(["bluetoothctl", "power", "on"],
                           capture_output=True, timeout=5, check=False)
            time.sleep(1.0)
            print("  Adapter power-cycled via bluetoothctl", file=sys.stderr, flush=True)
    except Exception as e:
        print(f"  Adapter reset failed: {e}", file=sys.stderr, flush=True)


def _check_adapter_state():
    """Print adapter diagnostic info."""
    try:
        result = subprocess.run(
            ["bluetoothctl", "show"],
            capture_output=True, timeout=5, text=True, check=False,
        )
        for line in result.stdout.strip().splitlines():
            line = line.strip()
            if any(k in line for k in ["Powered", "Discovering", "Address"]):
                print(f"  Adapter: {line}", file=sys.stderr, flush=True)
    except Exception:
        pass


def _check_device_state(address: str):
    """Print device diagnostic info from BlueZ."""
    try:
        result = subprocess.run(
            ["bluetoothctl", "info", address],
            capture_output=True, timeout=5, text=True, check=False,
        )
        output = result.stdout.strip()
        if "not available" in output.lower():
            print(f"  Device {address}: not in BlueZ cache", file=sys.stderr, flush=True)
        else:
            for line in output.splitlines():
                line = line.strip()
                if any(k in line for k in ["Connected", "Paired", "Trusted", "Bonded", "Name"]):
                    print(f"  Device: {line}", file=sys.stderr, flush=True)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Bleak GATT read (subscribe to indications on already-connected device)
# ---------------------------------------------------------------------------

async def _read_indications(client, readings: list[dict]):
    """Subscribe to BP measurement indications and collect readings."""
    bp_char = None
    for service in client.services:
        for char in service.characteristics:
            if BP_MEASUREMENT_CHAR.lower() in char.uuid.lower():
                bp_char = char
                break

    if not bp_char:
        print("  BP characteristic 0x2A35 not found", file=sys.stderr, flush=True)
        return

    print(f"  Subscribing to indications on {bp_char.uuid} ...", file=sys.stderr, flush=True)

    def on_indicate(_char, data: bytearray):
        reading = parse_bp_measurement(bytes(data))
        if reading and reading.get("systolic") is not None:
            readings.append(reading)
            print(f"  Reading: sys={reading.get('systolic')} "
                  f"dia={reading.get('diastolic')} "
                  f"pulse={reading.get('pulse_rate')}",
                  file=sys.stderr, flush=True)

    await client.start_notify(bp_char.uuid, on_indicate)

    elapsed = 0.0
    while elapsed < READ_TIMEOUT:
        await asyncio.sleep(0.5)
        elapsed += 0.5
        if readings and elapsed > 5.0:
            remaining = min(5.0, READ_TIMEOUT - elapsed)
            await asyncio.sleep(remaining)
            break

    print(f"  Got {len(readings)} reading(s)", file=sys.stderr, flush=True)

    try:
        await client.stop_notify(bp_char.uuid)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# v14: Direct Bleak connect — same proven strategy as bp_provision.py
# ---------------------------------------------------------------------------

async def _attempt_bleak_connect(address: str, readings: list[dict]) -> bool:
    """Connect via Bleak using detection callback, then read indications.

    Same proven strategy as bp_provision.py:
    1. BleakScanner with detection_callback to grab a fresh BLEDevice
       the instant the monitor advertises.
    2. BleakClient(ble_device) direct connect — passes the live BLEDevice
       object so Bleak has the correct D-Bus object path.
    3. Subscribe to 0x2A35 indications and collect readings.

    IMPORTANT: No 'remove' command is issued — the existing BLE bond
    from provisioning (bp_provision.py pair_device) is preserved.
    """
    from bleak import BleakScanner, BleakClient

    # Step 1: Scan for the device to get a fresh BLEDevice object.
    # The parent scanner already detected it, so the monitor should still
    # be advertising (it advertises for ~30s after pressing Bluetooth).
    ble_device = None
    found_event = asyncio.Event()

    def _on_detect(device, adv_data):
        nonlocal ble_device
        if device.address.upper() == address.upper():
            ble_device = device
            print(f"  TARGET DETECTED: {device.name or address} RSSI={adv_data.rssi}",
                  file=sys.stderr, flush=True)
            found_event.set()

    scan_timeout = 15.0
    print(f"  Scanning for {address} (up to {scan_timeout}s) ...", file=sys.stderr, flush=True)
    scanner = BleakScanner(detection_callback=_on_detect)
    await scanner.start()
    try:
        await asyncio.wait_for(found_event.wait(), timeout=scan_timeout)
    except asyncio.TimeoutError:
        print(f"  Device {address} not found in {scan_timeout}s", file=sys.stderr, flush=True)
    finally:
        await scanner.stop()

    if ble_device is None:
        print(f"  Device {address} not advertising — cannot connect", file=sys.stderr, flush=True)
        return False

    # Step 2: Connect immediately using the fresh BLEDevice.
    # This is the EXACT same approach bp_provision.py uses successfully.
    client = None
    try:
        print(f"  Connecting to {address} with fresh BLEDevice ...", file=sys.stderr, flush=True)
        client = BleakClient(ble_device, timeout=15.0)
        await client.connect()

        if not client.is_connected:
            print(f"  connect() returned but not connected", file=sys.stderr, flush=True)
            return False

        print(f"  CONNECTED — reading indications", file=sys.stderr, flush=True)

        # Step 3: Read BP measurement indications
        await _read_indications(client, readings)

    except Exception as e:
        print(f"  BLE error: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
    finally:
        if client:
            try:
                await client.disconnect()
            except Exception:
                pass

    return len(readings) > 0


# ---------------------------------------------------------------------------
# Main oneshot read orchestrator
# ---------------------------------------------------------------------------

async def _oneshot_read(address: str) -> list[dict]:
    """One-shot BLE read — subprocess mode.

    v14: Direct Bleak connect — same proven approach as bp_provision.py.
    Uses BleakScanner detection callback to grab a fresh BLEDevice the
    instant the monitor advertises, then connects immediately via
    BleakClient(ble_device).

    Key difference from v13: NO 'remove {address}' command.  v13 destroyed
    the BLE bond before every read, leaving the device Paired: no,
    Bonded: no.  v14 preserves the bond established during provisioning.

    Attempt 1: BleakScanner detection → BleakClient direct connect
    Attempt 2: adapter reset + retry
    """
    address = address.upper()
    readings: list[dict] = []

    # --- Diagnostics ---
    _check_adapter_state()
    _check_device_state(address)

    # --- Pre-flight: clear ghost connections ---
    ghosts = _check_ghost_connections()
    for ghost_mac in ghosts:
        _disconnect_device(ghost_mac)
    if ghosts:
        await asyncio.sleep(1.0)

    # =================================================================
    #  ATTEMPT 1: Direct Bleak connect (same as bp_provision.py)
    # =================================================================
    print("ATTEMPT 1/2 — direct Bleak connect", file=sys.stderr, flush=True)

    if await _attempt_bleak_connect(address, readings):
        return readings
    print("  Attempt 1 failed", file=sys.stderr, flush=True)

    # =================================================================
    #  ATTEMPT 2: Adapter reset + retry
    # =================================================================
    print("ATTEMPT 2/2 — adapter reset + direct Bleak connect", file=sys.stderr, flush=True)
    _reset_adapter()
    await asyncio.sleep(2.0)

    if await _attempt_bleak_connect(address, readings):
        return readings
    print("  Attempt 2 failed", file=sys.stderr, flush=True)

    return readings


def run_oneshot_read(address: str):
    """Entry point for --read mode. Prints readings as JSON lines to stdout."""
    readings = asyncio.run(_oneshot_read(address))
    for r in readings:
        print(json.dumps(r), flush=True)
    sys.exit(0 if readings else 1)


# ===================================================================
#  PARENT BRIDGE MODE  (default — runs as pm2 service)
# ===================================================================

def read_device_subprocess(address: str) -> list[dict]:
    """Spawn a fresh subprocess to do the BLE read."""
    address = address.upper()
    log.info("=== BP READ START for %s (subprocess) ===", address)

    script_path = os.path.abspath(__file__)
    cmd = [sys.executable, script_path, "--read", address]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=SUBPROCESS_TIMEOUT,
            env={**os.environ, "BP_LOG_LEVEL": LOG_LEVEL},
        )
    except subprocess.TimeoutExpired:
        log.warning("  Subprocess timed out after %ds for %s", SUBPROCESS_TIMEOUT, address)
        log.info("=== BP READ DONE for %s: 0 collected, 0 forwarded (timeout) ===", address)
        return []

    if result.stderr:
        for line in result.stderr.strip().splitlines():
            log.info("  [child] %s", line)

    readings = []
    for line in result.stdout.strip().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            reading = json.loads(line)
            if reading.get("systolic") is not None:
                readings.append(reading)
        except json.JSONDecodeError:
            log.debug("  Non-JSON stdout line: %s", line)

    forwarded = 0
    for reading in readings:
        if forward_reading(address, reading):
            forwarded += 1

    log.info("=== BP READ DONE for %s: %d collected, %d forwarded (exit=%d) ===",
             address, len(readings), forwarded, result.returncode)
    return readings


# ---------------------------------------------------------------------------
# Parent scanner — REAL-TIME: returns immediately when target MAC found
# ---------------------------------------------------------------------------

async def _btctl_scan_realtime(known_macs: set[str], timeout: int = 20) -> str | None:
    """Real-time BLE scan that returns IMMEDIATELY when a target MAC is found.

    Instead of waiting the full scan duration and then parsing output,
    this reads bluetoothctl output line-by-line and returns the instant
    a known MAC appears.  This saves ~12 seconds on average — critical
    because the cuff only advertises for ~30 seconds.
    """
    proc = await asyncio.create_subprocess_exec(
        "bluetoothctl",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )

    found_mac = None
    try:
        # Power on and start LE scan
        proc.stdin.write(b"power on\n")
        await proc.stdin.drain()
        await asyncio.sleep(0.3)
        proc.stdin.write(b"scan le\n")
        await proc.stdin.drain()

        deadline = asyncio.get_event_loop().time() + timeout
        while asyncio.get_event_loop().time() < deadline:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                break
            try:
                line_bytes = await asyncio.wait_for(
                    proc.stdout.readline(),
                    timeout=min(remaining, 2.0),
                )
                if not line_bytes:
                    break
                line = line_bytes.decode("utf-8", errors="replace")
                # Check for any known MAC in the line
                line_upper = line.upper()
                for mac in known_macs:
                    if mac in line_upper:
                        found_mac = mac
                        log.info("FOUND %s in scan (real-time match)", mac)
                        break
                if found_mac:
                    break
            except asyncio.TimeoutError:
                continue
    finally:
        # Stop scan and quit — ensure adapter is idle before child spawns
        try:
            proc.stdin.write(b"scan off\n")
            await proc.stdin.drain()
            await asyncio.sleep(0.5)
            proc.stdin.write(b"quit\n")
            await proc.stdin.drain()
        except Exception:
            pass
        try:
            await asyncio.wait_for(proc.wait(), timeout=3)
        except (asyncio.TimeoutError, Exception):
            proc.kill()
            try:
                await proc.wait()
            except Exception:
                pass

    return found_mac


async def scanner_loop():
    """Continuously scan for known BP monitors and read when detected.

    v14: Simplified — no pre-trust step needed. The bond from provisioning
    is preserved, and the child subprocess uses direct Bleak connect
    (same approach as bp_provision.py).
    """
    last_read: dict[str, float] = {}
    log.info("Scanner loop started (read_timeout=%ds, cooldown=%ds)", READ_TIMEOUT, COOLDOWN)

    while True:
        bp_devices = get_paired_bp_devices()
        if not bp_devices:
            log.debug("No paired BP monitors, sleeping 30s ...")
            await asyncio.sleep(30)
            continue

        known_macs = {d.get("ieee_address", "").upper() for d in bp_devices}
        known_macs.discard("")

        log.info("Scanning for %d BP monitor(s): %s", len(known_macs), ", ".join(known_macs))

        # Real-time scan — returns immediately on first match
        detected_address = await _btctl_scan_realtime(known_macs, timeout=20)

        if detected_address:
            if time.time() - last_read.get(detected_address, 0) < COOLDOWN:
                log.info("Cooldown active for %s, skipping", detected_address)
                await asyncio.sleep(5)
                continue

            log.info("BP MONITOR DETECTED: %s", detected_address)

            # Settle delay — let adapter fully stop scanning before
            # the child subprocess starts its own BleakScanner
            log.info("Settling adapter (1.5s) before spawning reader ...")
            await asyncio.sleep(1.5)

            readings = read_device_subprocess(detected_address)
            if readings:
                last_read[detected_address] = time.time()
                log.info("Cooldown active for %s (%ds)", detected_address, COOLDOWN)
            await asyncio.sleep(2.0)
        else:
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
    log.info("Starting BP bridge v14 (direct Bleak connect, backend=%s)", READING_ENDPOINT)
    asyncio.run(run())


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "--read":
        run_oneshot_read(sys.argv[2])
    else:
        main()
