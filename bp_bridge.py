#!/usr/bin/env python3
"""
bp_bridge.py  v6 — BLE bridge for Bluetooth Blood Pressure monitors.

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

v6 connect strategy (3-tier escalation):
    Attempt 1 — Direct connect by MAC address.  Preserves the existing
                BlueZ bond/pairing keys from bp_provision.py.  No remove,
                no scan — fastest path, works when bond is intact.
    Attempt 2 — Remove cached device from BlueZ + fresh scan + connect.
                Clears any stale GATT cache but sacrifices bonding keys.
                2-second settle time after removal.
    Attempt 3 — Full adapter reset (hci0 down/up) + remove + scan +
                connect.  Nuclear option — clears ghost connections and
                any wedged adapter state.

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

# Subprocess timeout — generous: 3 attempts × (scan+connect) + read + overhead
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

def _remove_cached_device(address: str):
    """Remove a cached/stale BLE device from BlueZ."""
    try:
        result = subprocess.run(
            ["bluetoothctl", "remove", address],
            capture_output=True, timeout=5, text=True, check=False,
        )
        print(f"  bluetoothctl remove: {result.stdout.strip()}", file=sys.stderr, flush=True)
    except Exception as e:
        print(f"  bluetoothctl remove failed: {e}", file=sys.stderr, flush=True)


def _trust_device(address: str):
    """Trust device via bluetoothctl so BlueZ allows future connections."""
    try:
        subprocess.run(
            ["bluetoothctl", "trust", address],
            capture_output=True, timeout=5, text=True, check=False,
        )
    except Exception:
        pass


def _check_ghost_connections() -> list[str]:
    """Check for existing BLE connections that might block new ones.

    Returns list of connected MAC addresses.
    """
    try:
        result = subprocess.run(
            ["hcitool", "con"],
            capture_output=True, timeout=5, text=True, check=False,
        )
        lines = result.stdout.strip().splitlines()
        connected = []
        for line in lines:
            # Format: "  < LE 00:09:1F:A8:7E:5A handle 64 state 1 lm MASTER"
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
        result = subprocess.run(
            ["bluetoothctl", "disconnect", address],
            capture_output=True, timeout=5, text=True, check=False,
        )
        print(f"  bluetoothctl disconnect {address}: {result.stdout.strip()}", file=sys.stderr, flush=True)
    except Exception as e:
        print(f"  disconnect failed: {e}", file=sys.stderr, flush=True)


def _reset_adapter():
    """Reset the BLE adapter to clear all state.

    Brings hci0 down and back up.  Clears ghost connections, stale
    GATT caches, and any wedged adapter state.
    """
    print("  Resetting BLE adapter (hci0 down/up) ...", file=sys.stderr, flush=True)
    try:
        subprocess.run(
            ["sudo", "hciconfig", "hci0", "down"],
            capture_output=True, timeout=5, text=True, check=False,
        )
        time.sleep(1.0)
        subprocess.run(
            ["sudo", "hciconfig", "hci0", "up"],
            capture_output=True, timeout=5, text=True, check=False,
        )
        time.sleep(2.0)
        print("  Adapter reset complete", file=sys.stderr, flush=True)
    except Exception as e:
        print(f"  Adapter reset failed: {e}", file=sys.stderr, flush=True)


async def _scan_for_device(address: str, timeout: float = 10.0):
    """Run a targeted BLE scan and return the BLEDevice if found."""
    from bleak import BleakScanner

    ble_device = None
    found_event = asyncio.Event()

    def _on_detect(device, adv_data):
        nonlocal ble_device
        if device.address.upper() == address:
            ble_device = device
            print(f"  Scan found {address} (RSSI={adv_data.rssi})", file=sys.stderr, flush=True)
            found_event.set()

    scanner = BleakScanner(detection_callback=_on_detect)
    await scanner.start()
    try:
        await asyncio.wait_for(found_event.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        print(f"  Device {address} not found in {timeout}s scan", file=sys.stderr, flush=True)
    finally:
        await scanner.stop()

    return ble_device


async def _try_connect(address: str, ble_device, timeout: float = 20.0):
    """Attempt a single GATT connection.  Returns (BleakClient, True) or (None, False)."""
    from bleak import BleakClient

    client = None
    try:
        print(f"  Connecting to {address} (timeout={timeout}s) ...", file=sys.stderr, flush=True)
        client = BleakClient(ble_device, timeout=timeout)
        await client.connect()
        if client.is_connected:
            print(f"  CONNECTED to {address}", file=sys.stderr, flush=True)
            return client, True
        else:
            print(f"  connect() returned but is_connected=False", file=sys.stderr, flush=True)
    except Exception as e:
        print(f"  Connect failed: {type(e).__name__}: {e}", file=sys.stderr, flush=True)

    if client:
        try:
            await client.disconnect()
        except Exception:
            pass
    return None, False


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

    # Wait for indications (device sends stored readings immediately)
    elapsed = 0.0
    while elapsed < READ_TIMEOUT:
        await asyncio.sleep(0.5)
        elapsed += 0.5
        # Once we have at least one reading, wait 5 more seconds for any others
        if readings and elapsed > 5.0:
            remaining = min(5.0, READ_TIMEOUT - elapsed)
            await asyncio.sleep(remaining)
            break

    print(f"  Got {len(readings)} reading(s)", file=sys.stderr, flush=True)

    try:
        await client.stop_notify(bp_char.uuid)
    except Exception:
        pass


async def _oneshot_read(address: str) -> list[dict]:
    """One-shot BLE read — called only in subprocess (--read) mode.

    Three-tier escalation strategy:

    Attempt 1 — DIRECT CONNECT (preserve bond)
        Connect by MAC address without removing the device first.
        This preserves bonding keys from bp_provision.py.
        Fastest path — if the bond is intact and BlueZ has the device
        cached from the parent's scan, this connects in <2s.

    Attempt 2 — REMOVE + SCAN + CONNECT
        Remove the cached device from BlueZ (clears stale GATT cache),
        wait 2s for BlueZ to settle, run a fresh scan, then connect.
        Sacrifices bonding keys but fixes stale-cache issues.

    Attempt 3 — ADAPTER RESET + REMOVE + SCAN + CONNECT
        Full nuclear option: bring hci0 down/up to clear ghost
        connections and any wedged adapter state, then remove + scan
        + connect.
    """
    from bleak import BleakClient

    address = address.upper()
    readings: list[dict] = []

    # --- Pre-flight: clear any ghost connections ---
    ghosts = _check_ghost_connections()
    for ghost_mac in ghosts:
        _disconnect_device(ghost_mac)
    if ghosts:
        await asyncio.sleep(1.0)

    # =================================================================
    #  ATTEMPT 1: Direct connect (preserve bond)
    # =================================================================
    print("ATTEMPT 1/3 — Direct connect (preserving bond)", file=sys.stderr, flush=True)

    # Try to connect directly by address — BlueZ may have the device
    # from the parent's scan, and the bonding keys from provisioning
    # let us skip re-pairing.  Use a shorter timeout here (12s) because
    # a working bond-based connect should complete in 2-5s.  Saving time
    # here preserves more of the ~30s advertising window for attempts 2/3.
    client, connected = await _try_connect(address, address, timeout=12.0)

    if connected and client:
        _trust_device(address)
        try:
            await _read_indications(client, readings)
        except Exception as e:
            print(f"  Read error: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
        finally:
            try:
                await client.disconnect()
                print(f"  Disconnected from {address}", file=sys.stderr, flush=True)
            except Exception:
                pass
        if readings:
            return readings
        # Connected but got zero readings — still try next attempts
        print("  Connected but no readings, escalating ...", file=sys.stderr, flush=True)

    # =================================================================
    #  ATTEMPT 2: Remove cached device + fresh scan + connect
    # =================================================================
    print("ATTEMPT 2/3 — Remove + scan + connect", file=sys.stderr, flush=True)

    _remove_cached_device(address)
    await asyncio.sleep(2.0)  # Give BlueZ time to clean up

    ble_device = await _scan_for_device(address, timeout=10.0)
    if ble_device:
        client, connected = await _try_connect(address, ble_device, timeout=20.0)
        if connected and client:
            _trust_device(address)
            try:
                await _read_indications(client, readings)
            except Exception as e:
                print(f"  Read error: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
            finally:
                try:
                    await client.disconnect()
                    print(f"  Disconnected from {address}", file=sys.stderr, flush=True)
                except Exception:
                    pass
            if readings:
                return readings
            print("  Connected but no readings, escalating ...", file=sys.stderr, flush=True)
    else:
        print("  Device not found in scan, escalating ...", file=sys.stderr, flush=True)

    # =================================================================
    #  ATTEMPT 3: Full adapter reset + remove + scan + connect
    # =================================================================
    print("ATTEMPT 3/3 — Adapter reset + remove + scan + connect", file=sys.stderr, flush=True)

    _reset_adapter()
    _remove_cached_device(address)
    await asyncio.sleep(2.0)

    ble_device = await _scan_for_device(address, timeout=12.0)
    if ble_device:
        client, connected = await _try_connect(address, ble_device, timeout=20.0)
        if connected and client:
            _trust_device(address)
            try:
                await _read_indications(client, readings)
            except Exception as e:
                print(f"  Read error: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
            finally:
                try:
                    await client.disconnect()
                    print(f"  Disconnected from {address}", file=sys.stderr, flush=True)
                except Exception:
                    pass
    else:
        print("  Device not found even after adapter reset", file=sys.stderr, flush=True)

    return readings


def run_oneshot_read(address: str):
    """Entry point for --read mode. Prints readings as JSON lines to stdout."""
    readings = asyncio.run(_oneshot_read(address))
    # Each reading as a separate JSON line on stdout (parent parses these)
    for r in readings:
        print(json.dumps(r), flush=True)
    # Exit code: 0 if we got readings, 1 if not
    sys.exit(0 if readings else 1)


# ===================================================================
#  PARENT BRIDGE MODE  (default — runs as pm2 service)
# ===================================================================

def read_device_subprocess(address: str) -> list[dict]:
    """Spawn a fresh subprocess to do the BLE read.

    The subprocess runs this same script in --read mode, giving it a
    clean BlueZ D-Bus session. Readings come back as JSON lines on stdout.
    """
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

    # Log subprocess stderr (diagnostic messages)
    if result.stderr:
        for line in result.stderr.strip().splitlines():
            log.info("  [child] %s", line)

    # Parse JSON readings from stdout
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

    # Forward all collected readings to backend
    forwarded = 0
    for reading in readings:
        if forward_reading(address, reading):
            forwarded += 1

    log.info("=== BP READ DONE for %s: %d collected, %d forwarded (exit=%d) ===",
             address, len(readings), forwarded, result.returncode)
    return readings


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

        detected_address = None
        found_event = asyncio.Event()

        def _on_detect(device, adv_data):
            nonlocal detected_address
            mac = device.address.upper()
            if mac not in known_macs:
                return
            # Check cooldown
            last = last_read.get(mac, 0)
            if time.time() - last < COOLDOWN:
                return
            detected_address = mac
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

        if detected_address:
            # Stop the scanner BEFORE spawning the subprocess — avoids
            # two processes fighting over the BLE adapter.
            readings = read_device_subprocess(detected_address)
            if readings:
                last_read[detected_address] = time.time()
                log.info("Cooldown active for %s (%ds)", detected_address, COOLDOWN)
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
    log.info("Starting BP bridge v6 (3-tier connect, backend=%s)", READING_ENDPOINT)
    asyncio.run(run())


if __name__ == "__main__":
    # --read mode: one-shot subprocess for BLE connect+read
    if len(sys.argv) >= 3 and sys.argv[1] == "--read":
        run_oneshot_read(sys.argv[2])
    else:
        main()
