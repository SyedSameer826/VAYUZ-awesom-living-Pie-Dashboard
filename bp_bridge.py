#!/usr/bin/env python3
"""
bp_bridge.py  v11 — BLE bridge for Bluetooth Blood Pressure monitors.

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

v11 connect strategy — trust-first (based on successful manual testing):
    Manual interactive testing proved the A&D UA-656BLE connects reliably
    with this exact sequence:
      1. bluetoothctl remove <MAC>   — clear stale BlueZ cache
      2. BLE scan discovers device   — re-adds to BlueZ cache
      3. bluetoothctl trust <MAC>    — mark as trusted
      4. BlueZ auto-connects         — trusted + discovered = auto-connect
      5. Bleak wraps connection       — for GATT indication reads

    v10's piped interactive bluetoothctl session (trust+connect in one
    bash pipe) had timing issues and the "quit" at the end could tear
    down the connection.  v11 replaces that with individual bluetoothctl
    commands matching the proven manual sequence, then lets Bleak handle
    the GATT layer.

    Parent — bluetoothctl scan (no Bleak, no D-Bus state)
    Child  — Attempt 1: remove + scan + trust + wait + Bleak connect + read
             Attempt 2: adapter reset + scan + trust + wait + Bleak connect + read

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

# Subprocess timeout — generous: 2 attempts × (scan+connect) + read + overhead
SUBPROCESS_TIMEOUT = 120

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
        output = result.stdout.strip()
        if "removed" in output.lower():
            print(f"  bluetoothctl remove: {output}", file=sys.stderr, flush=True)
        elif "not available" in output.lower():
            print(f"  Device {address} not in cache (clean slate)", file=sys.stderr, flush=True)
        else:
            print(f"  bluetoothctl remove: {output}", file=sys.stderr, flush=True)
    except Exception as e:
        print(f"  bluetoothctl remove failed: {e}", file=sys.stderr, flush=True)


def _trust_device(address: str):
    """Trust device via bluetoothctl so BlueZ allows auto-connect."""
    try:
        result = subprocess.run(
            ["bluetoothctl", "trust", address],
            capture_output=True, timeout=5, text=True, check=False,
        )
        output = result.stdout.strip()
        if "trust succeeded" in output.lower():
            print(f"  Trust succeeded for {address}", file=sys.stderr, flush=True)
        elif "not available" in output.lower():
            print(f"  Trust failed — device {address} not in BlueZ cache yet", file=sys.stderr, flush=True)
        else:
            print(f"  bluetoothctl trust: {output}", file=sys.stderr, flush=True)
    except Exception as e:
        print(f"  bluetoothctl trust failed: {e}", file=sys.stderr, flush=True)


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
        result = subprocess.run(
            ["bluetoothctl", "disconnect", address],
            capture_output=True, timeout=5, text=True, check=False,
        )
        print(f"  bluetoothctl disconnect {address}: {result.stdout.strip()}", file=sys.stderr, flush=True)
    except Exception as e:
        print(f"  disconnect failed: {e}", file=sys.stderr, flush=True)


def _reset_adapter():
    """Reset the BLE adapter to clear all state."""
    print("  Resetting BLE adapter ...", file=sys.stderr, flush=True)
    try:
        # Try hciconfig reset first (more thorough)
        r = subprocess.run(
            ["hciconfig", "hci0", "reset"],
            capture_output=True, timeout=5, text=True, check=False,
        )
        if r.returncode == 0:
            print("  Adapter reset via hciconfig hci0 reset", file=sys.stderr, flush=True)
            time.sleep(1.5)
        else:
            # Fallback: power cycle via bluetoothctl
            subprocess.run(
                ["bluetoothctl", "power", "off"],
                capture_output=True, timeout=5, check=False,
            )
            time.sleep(0.5)
            subprocess.run(
                ["bluetoothctl", "power", "on"],
                capture_output=True, timeout=5, check=False,
            )
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
            if any(k in line for k in ["Powered", "Discovering", "Pairable", "Address"]):
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


def _is_device_connected(address: str) -> bool:
    """Check if device is currently connected via bluetoothctl info."""
    try:
        result = subprocess.run(
            ["bluetoothctl", "info", address],
            capture_output=True, timeout=5, text=True, check=False,
        )
        for line in result.stdout.splitlines():
            if "Connected: yes" in line:
                return True
    except Exception:
        pass
    return False


def _bluetoothctl_connect(address: str, timeout: int = 15) -> bool:
    """Connect to device using bluetoothctl (native BlueZ, no Bleak)."""
    print(f"  bluetoothctl connect {address} (timeout={timeout}s) ...", file=sys.stderr, flush=True)
    try:
        result = subprocess.run(
            ["bluetoothctl", "connect", address],
            capture_output=True, timeout=timeout, text=True, check=False,
        )
        output = (result.stdout + " " + result.stderr).strip()
        if "Connection successful" in output:
            print(f"  bluetoothctl: Connection successful!", file=sys.stderr, flush=True)
            return True
        elif "InProgress" in output or "Already connected" in output.replace(" ", ""):
            # BlueZ is already connecting/connected — check state
            print(f"  bluetoothctl: InProgress/Already connected, checking ...", file=sys.stderr, flush=True)
            time.sleep(2.0)
            if _is_device_connected(address):
                print(f"  Device is connected (confirmed via info)", file=sys.stderr, flush=True)
                return True
        else:
            for line in output.splitlines():
                line = line.strip()
                if line:
                    print(f"  bluetoothctl: {line}", file=sys.stderr, flush=True)
        return False
    except subprocess.TimeoutExpired:
        print(f"  bluetoothctl connect timed out after {timeout}s", file=sys.stderr, flush=True)
        # Even on timeout, the connection might have been established
        if _is_device_connected(address):
            print(f"  But device IS connected (confirmed via info)", file=sys.stderr, flush=True)
            return True
        return False
    except Exception as e:
        print(f"  bluetoothctl connect error: {e}", file=sys.stderr, flush=True)
        return False


def _full_cleanup(address: str):
    """Force-disconnect + remove a device to clear ALL BlueZ state.

    Must be called before connection attempts to start from a clean slate.
    """
    print(f"  Cleanup: disconnect + remove {address} ...", file=sys.stderr, flush=True)
    try:
        subprocess.run(
            ["bluetoothctl", "disconnect", address],
            capture_output=True, timeout=5, text=True, check=False,
        )
    except Exception:
        pass
    time.sleep(0.5)
    try:
        subprocess.run(
            ["bluetoothctl", "remove", address],
            capture_output=True, timeout=5, text=True, check=False,
        )
    except Exception:
        pass
    time.sleep(1.5)
    print(f"  Cleanup done", file=sys.stderr, flush=True)


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


async def _connect_and_read_bp(address: str, ble_device, readings: list[dict]) -> bool:
    """Connect to BP cuff and read indications.

    v11 strategy: after discover+trust, BlueZ often auto-connects trusted
    devices.  Bleak's connect() gracefully wraps already-established
    connections.  Falls back to explicit bluetoothctl connect if Bleak
    connect fails.
    """
    from bleak import BleakClient

    client = None
    connected = False

    # --- Method A: Bleak connect (may wrap auto-connection from trust) ---
    try:
        print(f"  Bleak connect to {address} (timeout=20s) ...", file=sys.stderr, flush=True)
        client = BleakClient(ble_device, timeout=20.0)
        await client.connect()
        connected = client.is_connected
        if connected:
            print(f"  Bleak CONNECTED (services resolved)", file=sys.stderr, flush=True)
    except Exception as e:
        err_msg = str(e).lower()
        print(f"  Bleak connect error: {type(e).__name__}: {e}", file=sys.stderr, flush=True)

        # InProgress = BlueZ is already auto-connecting after trust.
        # Wait for it to finish, then retry with address string.
        if "inprogress" in err_msg or "in progress" in err_msg:
            print(f"  InProgress — waiting 3s for BlueZ auto-connect ...", file=sys.stderr, flush=True)
            if client:
                try:
                    await client.disconnect()
                except Exception:
                    pass
                client = None
            await asyncio.sleep(3.0)

            # Check if BlueZ auto-connected
            if _is_device_connected(address):
                print(f"  Device auto-connected! Wrapping with Bleak ...", file=sys.stderr, flush=True)
            try:
                client = BleakClient(address, timeout=15.0)
                await client.connect()
                connected = client.is_connected
                if connected:
                    print(f"  Bleak CONNECTED (after InProgress wait)", file=sys.stderr, flush=True)
            except Exception as e2:
                print(f"  InProgress retry failed: {type(e2).__name__}: {e2}", file=sys.stderr, flush=True)

    # --- Method B: explicit bluetoothctl connect + Bleak wrap ---
    if not connected:
        if client:
            try:
                await client.disconnect()
            except Exception:
                pass
            client = None

        print(f"  Fallback: explicit bluetoothctl connect ...", file=sys.stderr, flush=True)
        btctl_ok = _bluetoothctl_connect(address, timeout=15)

        if btctl_ok:
            await asyncio.sleep(1.0)
            try:
                client = BleakClient(address, timeout=15.0)
                await client.connect()
                connected = client.is_connected
                if connected:
                    print(f"  Bleak CONNECTED (via bluetoothctl fallback)", file=sys.stderr, flush=True)
            except Exception as e:
                print(f"  bluetoothctl+Bleak wrap failed: {type(e).__name__}: {e}", file=sys.stderr, flush=True)

    if not connected or client is None:
        print(f"  All connect methods failed for {address}", file=sys.stderr, flush=True)
        if client:
            try:
                await client.disconnect()
            except Exception:
                pass
        return False

    # --- Read BP indications ---
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

    return len(readings) > 0


async def _oneshot_read(address: str) -> list[dict]:
    """One-shot BLE read — called only in subprocess (--read) mode.

    v11 trust-first strategy (based on successful manual testing):

    The A&D UA-656BLE connects reliably when the sequence is:
        remove → scan (discover) → trust → (auto-connect) → Bleak read

    Manual testing confirmed:
      - Connected: yes with UUID Blood Pressure (0x1810)
      - Paired: no, Bonded: no — no SMP pairing needed
      - Connection stayed stable until explicit disconnect
      - BlueZ auto-connected after trust (connect returned InProgress)

    Two-tier escalation:
      Attempt 1 — remove + scan + trust + Bleak connect + read
      Attempt 2 — adapter reset + scan + trust + Bleak connect + read
    """
    address = address.upper()
    readings: list[dict] = []

    # --- Diagnostics: adapter & device state ---
    _check_adapter_state()
    _check_device_state(address)

    # --- Pre-flight: clear any ghost connections ---
    ghosts = _check_ghost_connections()
    for ghost_mac in ghosts:
        _disconnect_device(ghost_mac)
    if ghosts:
        await asyncio.sleep(1.0)

    # =================================================================
    #  ATTEMPT 1: remove + scan + trust + connect + read
    #  Matches the exact sequence that worked in manual testing.
    # =================================================================
    print("ATTEMPT 1/2 — remove + scan + trust + connect (trust-first)", file=sys.stderr, flush=True)

    # Step 1: Clean slate — remove stale cache
    _full_cleanup(address)

    # Step 2: Scan to discover device (re-adds to BlueZ cache)
    ble_device = await _scan_for_device(address, timeout=10.0)
    if ble_device:
        # Step 3: Trust the device (now in cache from scan)
        await asyncio.sleep(0.5)  # let BlueZ fully cache the discovery
        _trust_device(address)

        # Step 4: Give BlueZ time to auto-connect (trusted + discovered)
        print("  Waiting 2s for BlueZ auto-connect ...", file=sys.stderr, flush=True)
        await asyncio.sleep(2.0)

        # Step 5: Bleak connect + read indications
        if await _connect_and_read_bp(address, ble_device, readings):
            return readings
        print("  Attempt 1 failed", file=sys.stderr, flush=True)
    else:
        print("  Device not found in scan, escalating ...", file=sys.stderr, flush=True)

    # =================================================================
    #  ATTEMPT 2: adapter reset + scan + trust + connect + read
    # =================================================================
    print("ATTEMPT 2/2 — adapter reset + scan + trust + connect", file=sys.stderr, flush=True)

    _full_cleanup(address)
    _reset_adapter()
    await asyncio.sleep(3.0)

    ble_device = await _scan_for_device(address, timeout=12.0)
    if ble_device:
        await asyncio.sleep(0.5)
        _trust_device(address)
        print("  Waiting 2s for BlueZ auto-connect ...", file=sys.stderr, flush=True)
        await asyncio.sleep(2.0)

        await _connect_and_read_bp(address, ble_device, readings)
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
# Parent scanner — uses bluetoothctl (no Bleak, no D-Bus adapter state)
# ---------------------------------------------------------------------------
def _btctl_scan_once(known_macs: set[str], timeout: int = 15) -> str | None:
    """Run a single BLE scan via bluetoothctl and return first known MAC found.

    This avoids importing Bleak in the parent process — BleakScanner holds
    D-Bus adapter references that interfere with the child subprocess's BLE
    connections even after stop().
    """
    script = (
        "{ "
        'echo "scan le"; '
        f"sleep {timeout}; "
        'echo "scan off"; sleep 0.3; echo "quit"; '
        "} | bluetoothctl 2>&1"
    )
    try:
        result = subprocess.run(
            ["bash", "-c", script],
            capture_output=True, timeout=timeout + 10, text=True, check=False,
        )
        for line in result.stdout.splitlines():
            # Lines look like: [NEW] Device AA:BB:CC:DD:EE:FF DeviceName
            #               or: [CHG] Device AA:BB:CC:DD:EE:FF RSSI: int16
            if "Device" not in line:
                continue
            for part in line.split():
                cleaned = part.strip("[](),")
                if len(cleaned) == 17 and cleaned.count(":") == 5:
                    mac = cleaned.upper()
                    if mac in known_macs:
                        return mac
    except subprocess.TimeoutExpired:
        log.debug("bluetoothctl scan timed out")
    except Exception as e:
        log.warning("bluetoothctl scan error: %s", e)
    return None


async def scanner_loop():
    """Continuously scan for known BP monitors and read when detected.

    Uses bluetoothctl for scanning — NO Bleak in the parent process.
    This ensures the child subprocess gets a completely clean D-Bus session
    with no pre-existing adapter references.

    A per-device cooldown prevents re-reading the same advertisement burst.
    """
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

        # Run the blocking bluetoothctl scan in a thread so we don't
        # freeze the event loop (needed for signal handling).
        detected_address = await asyncio.to_thread(
            _btctl_scan_once, known_macs, 15,
        )

        if detected_address:
            # Check cooldown
            if time.time() - last_read.get(detected_address, 0) < COOLDOWN:
                log.info("Cooldown active for %s, skipping", detected_address)
                await asyncio.sleep(5)
                continue

            log.info("BP MONITOR DETECTED: %s", detected_address)

            # No scanner D-Bus state to clean up — parent never imported Bleak
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
    log.info("Starting BP bridge v11 (trust-first, auto-connect, backend=%s)", READING_ENDPOINT)
    asyncio.run(run())


if __name__ == "__main__":
    # --read mode: one-shot subprocess for BLE connect+read
    if len(sys.argv) >= 3 and sys.argv[1] == "--read":
        run_oneshot_read(sys.argv[2])
    else:
        main()
