#!/usr/bin/env python3
"""
bp_provision.py — A&D UA-656BLE BLE scan & pairing for the Pi dashboard.

Called by server.js:
    POST /api/bp/scan   →  python3 bp_provision.py scan --timeout 10
    POST /api/bp/pair   →  python3 bp_provision.py pair --address <MAC>

Based on A&D's reference pairing script (ad_pair.py) and the official
A&D BLE specification for the UA-656BLE.

Requirements:
    pip3 install --break-system-packages bleak

Pairing procedure (from Integration PDF Section 7):
    *** CRITICAL — the cuff must have its bond memory cleared FIRST ***
    1. Remove cuff batteries for 30 seconds (clears cuff-side bond keys).
    2. Reinsert batteries.
    3. Hold the cuff's START button ~3 s until display blinks "Pr".
    4. Run this script (or trigger via the Pi dashboard "Pair BP" button).
    5. Script clears Pi-side BlueZ state, restarts bluetooth service,
       registers a D-Bus pairing agent, connects, bonds, writes DateTime,
       and sets memory buffer to 200.
    6. Cuff display shows "End" when pairing completes.

IMPORTANT:
    - The cuff supports only ONE bonded master. Never pair it to a phone.
    - After a successful pair, bp_bridge.py handles all subsequent reads.
    - The memory buffer config (cmd 0xA6 = 200 readings) is CRITICAL —
      without it, readings taken while the bridge is down may be lost.
    - ERR 10 on the cuff means bond key mismatch — the cuff's battery
      MUST be removed for 30s to clear its side of the bond.
"""

from __future__ import annotations

import argparse
import asyncio
import datetime
import json
import struct
import subprocess
import sys
import time


# ---------------------------------------------------------------------------
# BLE UUIDs & constants
# ---------------------------------------------------------------------------

# Device name prefix — A&D UA-656BLE advertises as "A&D_UA-656BLE_xxxxxx"
DEVICE_NAME_PREFIX = "A&D_UA-656BLE"

# Blood Pressure Service (Bluetooth SIG 0x1810)
BP_SERVICE_UUID = "00001810-0000-1000-8000-00805f9b34fb"

# Date Time characteristic (0x2A08) — must be written every connection
DATETIME_CHAR = "00002a08-0000-1000-8000-00805f9b34fb"

# A&D Custom Service characteristic — for buffer configuration
CUSTOM_CHAR = "233bf001-5a34-1b6d-975c-000d5690abe4"

# Custom service commands (spec section 5)
# Frame: [Size][Type][Command][Value...]  Type: 0=read, 1=write
CMD_SET_BUFFER_200 = bytes([0x03, 0x01, 0xA6, 0x02])  # Set buffer to 200 readings
CMD_READ_BUFFER = bytes([0x02, 0x00, 0xD6])            # Read current buffer config


def _dbg(msg: str):
    """Debug output to stderr (doesn't pollute JSON stdout)."""
    print(f"[BP] {msg}", file=sys.stderr, flush=True)


def _exc_detail(e: Exception) -> str:
    s = str(e)
    return f"{type(e).__name__}: {s}" if s else f"{type(e).__name__}: {e!r}"


def _datetime_payload() -> bytes:
    """Build Date Time (0x2A08) payload: year uint16 LE, month..second."""
    now = datetime.datetime.now()
    return struct.pack("<HBBBBB", now.year, now.month, now.day,
                       now.hour, now.minute, now.second)


# ---------------------------------------------------------------------------
# BlueZ full cleanup — Integration PDF Section 7, Step 1
# ---------------------------------------------------------------------------
def _clear_bluez_state(address: str):
    """Remove device bond from BlueZ and restart the bluetooth service.

    The Integration PDF (Section 7, Step 1) requires BOTH:
      1. bluetoothctl remove <address>
      2. sudo systemctl restart bluetooth
    Without the service restart, BlueZ may retain cached state that
    causes the next connection attempt to use stale encryption keys.
    """
    _dbg(f"Step 0a: Removing {address} from BlueZ ...")
    subprocess.run(
        ["bluetoothctl", "untrust", address],
        capture_output=True, timeout=5, text=True, check=False,
    )
    result_rm = subprocess.run(
        ["bluetoothctl", "remove", address],
        capture_output=True, timeout=5, text=True, check=False,
    )
    _dbg(f"  remove: {result_rm.stdout.strip()} {result_rm.stderr.strip()}")

    _dbg("Step 0b: Restarting bluetooth service ...")
    result_restart = subprocess.run(
        ["sudo", "systemctl", "restart", "bluetooth"],
        capture_output=True, timeout=15, text=True, check=False,
    )
    if result_restart.returncode == 0:
        _dbg("  bluetooth service restarted OK")
    else:
        _dbg(f"  systemctl restart failed: {result_restart.stderr.strip()}")
        _dbg("  falling back to hciconfig reset ...")
        subprocess.run(
            ["sudo", "hciconfig", "hci0", "reset"],
            capture_output=True, timeout=5, check=False,
        )

    # Wait for BlueZ to reinitialize fully
    _dbg("  waiting for adapter to come back up ...")
    time.sleep(2.0)

    # Verify adapter is powered on (retry up to 3 times)
    for attempt in range(3):
        check = subprocess.run(
            ["bluetoothctl", "show"],
            capture_output=True, timeout=5, text=True, check=False,
        )
        if "Powered: yes" in check.stdout:
            _dbg("  adapter confirmed: Powered=yes")
            return
        _dbg(f"  adapter not powered yet (attempt {attempt + 1}/3), powering on ...")
        subprocess.run(
            ["bluetoothctl", "power", "on"],
            capture_output=True, timeout=5, check=False,
        )
        time.sleep(1.0)

    _dbg("  WARNING: could not confirm adapter powered (proceeding anyway)")


# ---------------------------------------------------------------------------
# D-Bus pairing agent — Integration PDF Section 8
# ---------------------------------------------------------------------------
def _start_pairing_agent():
    """Register a NoInputNoOutput BlueZ agent BEFORE the BLE connection.

    The Integration PDF Section 8 (Production Bridge Architecture) shows
    `dbus_helper() – agent + Pair()` as a required step before connecting.
    Without a registered agent, when the cuff sends a BLE Security Request
    during the connection phase, BlueZ has no agent to respond to the
    pairing exchange and the connection times out.

    Uses a persistent bluetoothctl subprocess — the agent lives as long
    as the process does. Killed in the finally block after pairing.
    """
    try:
        proc = subprocess.Popen(
            ["bluetoothctl"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        # Register NoInputNoOutput agent (Just Works pairing — no PIN)
        proc.stdin.write("agent NoInputNoOutput\n")
        proc.stdin.flush()
        time.sleep(0.4)
        proc.stdin.write("default-agent\n")
        proc.stdin.flush()
        time.sleep(0.4)
        _dbg(f"  D-Bus NoInputNoOutput agent registered (pid {proc.pid})")
        return proc
    except Exception as e:
        _dbg(f"  agent registration failed (non-fatal): {_exc_detail(e)}")
        return None


def _stop_pairing_agent(proc):
    """Shut down the bluetoothctl agent subprocess."""
    if proc is None:
        return
    try:
        if proc.poll() is None:
            proc.stdin.write("quit\n")
            proc.stdin.flush()
            proc.wait(timeout=3)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
    _dbg("  pairing agent process stopped")


# ---------------------------------------------------------------------------
# BLE Scan — find A&D BP monitors
# ---------------------------------------------------------------------------
async def scan_devices(timeout: float = 10.0) -> list[dict]:
    """Scan for A&D UA-656BLE monitors by name prefix and/or BP service."""
    from bleak import BleakScanner

    _dbg(f"Scanning for A&D BP monitors (timeout={timeout}s) ...")
    devices = []
    seen_addresses = set()

    discovered = await BleakScanner.discover(timeout=timeout, return_adv=True)
    _dbg(f"Scan complete — {len(discovered)} total BLE devices seen")

    for device, adv_data in discovered.values():
        name = adv_data.local_name or device.name or ""
        service_uuids = adv_data.service_uuids or []

        # Match by name prefix (primary) or by Blood Pressure Service UUID
        has_name_match = name.startswith(DEVICE_NAME_PREFIX)
        has_bp_service = any(
            BP_SERVICE_UUID.lower() in uuid.lower()
            for uuid in service_uuids
        )

        if (has_name_match or has_bp_service) and device.address not in seen_addresses:
            seen_addresses.add(device.address)
            devices.append({
                "address": device.address,
                "name": name or "BP Monitor",
                "rssi": adv_data.rssi,
            })
            _dbg(f"  Found: {name or 'unnamed'} @ {device.address} "
                 f"(RSSI {adv_data.rssi})")

    _dbg(f"BP monitors found: {len(devices)}")
    return devices


# ---------------------------------------------------------------------------
# BLE Pair — full procedure per Integration PDF Sections 7 & 8
# ---------------------------------------------------------------------------
async def pair_device(address: str, timeout: float = 30.0) -> dict:
    """Connect to a BP monitor, pair/bond, write DateTime, set buffer.

    Complete procedure per Integration PDF:

    Step 0: Clear Pi-side BlueZ state
        a) bluetoothctl remove <address>
        b) sudo systemctl restart bluetooth  (Section 7, Step 1)
        c) Wait for adapter to come back up

    Step 1: Register D-Bus NoInputNoOutput agent
        Per Section 8 production architecture: dbus_helper() – agent + Pair()
        The agent MUST be live before BleakClient.connect() so BlueZ can
        handle the cuff's Security Request during the connection phase.

    Step 2: Targeted scan for the device
        Detection callback for instant response when the cuff advertises.

    Step 3: Connect with extended timeout (30s)
        Using async with BleakClient for automatic disconnect cleanup.

    Step 4: Bond via client.pair()

    Step 5: Write DateTime to 0x2A08

    Step 6: Set memory buffer to 200 readings (cmd 0xA6)

    Step 7: Trust device in BlueZ for future connections

    PREREQUISITE (manual, cannot be done in software):
        The cuff's own bond memory must be cleared by removing its
        batteries for 30 seconds BEFORE running this script. Without
        this, the cuff still holds old encryption keys and will show
        ERR 10 on every connection attempt — no software fix can
        override this.
    """
    from bleak import BleakScanner, BleakClient

    _dbg(f"=== PAIR START for {address} ===")

    # -------------------------------------------------------------------
    # Step 0: Full BlueZ cleanup (Integration PDF Section 7, Step 1)
    # -------------------------------------------------------------------
    _clear_bluez_state(address)

    # -------------------------------------------------------------------
    # Step 1: Register D-Bus agent (Integration PDF Section 8)
    # Must be alive BEFORE BleakClient.connect() so BlueZ can handle
    # the cuff's Security Request during the connection phase.
    # -------------------------------------------------------------------
    _dbg("Step 1: Registering D-Bus pairing agent ...")
    agent_proc = _start_pairing_agent()

    try:
        # ---------------------------------------------------------------
        # Step 2: Targeted scan — find the device while it's advertising.
        # Uses a detection callback for instant response.
        # The cuff advertises for ~60s in Pr mode.
        # ---------------------------------------------------------------
        ble_device = None
        found_event = asyncio.Event()

        def _on_detect(device, adv_data):
            nonlocal ble_device
            if device.address.upper() == address.upper():
                ble_device = device
                name = adv_data.local_name or device.name or address
                _dbg(f"Step 2: TARGET DETECTED: {name} RSSI={adv_data.rssi}")
                found_event.set()

        scan_timeout = 30.0
        _dbg(f"Step 2: Scanning for {address} (up to {scan_timeout}s) ...")
        scanner = BleakScanner(detection_callback=_on_detect)
        await scanner.start()
        try:
            await asyncio.wait_for(found_event.wait(), timeout=scan_timeout)
        except asyncio.TimeoutError:
            _dbg(f"Step 2: Timed out — {address} did not advertise in {scan_timeout}s")
        finally:
            await scanner.stop()

        if ble_device is None:
            _dbg(f"Device {address} never advertised — cannot connect")
            return {
                "success": False,
                "detail": (
                    f"BP monitor {address} not found. "
                    "Make sure you removed the batteries for 30 seconds, "
                    "reinserted them, then held START ~3s until 'Pr' blinks. "
                    "Try again."
                ),
            }

        # ---------------------------------------------------------------
        # Step 3: Connect with extended timeout
        # The 30s timeout gives the BLE stack time to complete the full
        # pairing handshake (Security Request → agent response → key
        # exchange → encryption).
        # ---------------------------------------------------------------
        connect_timeout = 30.0
        _dbg(f"Step 3: Connecting to {address} (timeout={connect_timeout}s) ...")

        try:
            async with BleakClient(ble_device, timeout=connect_timeout) as client:
                _dbg(f"Step 3: CONNECTED to {address}")

                # --- Step 4: Bond ---
                _dbg("Step 4: Bonding ...")
                try:
                    paired = await client.pair()
                    _dbg(f"  pair(): {'OK' if paired else 'already bonded / not required'}")
                except Exception as pair_err:
                    # "In Progress" or "AlreadyExists" errors are benign
                    _dbg(f"  pair() note: {_exc_detail(pair_err)} (often fine if bond exists)")

                # --- Step 5: Write DateTime (0x2A08) — required every connection ---
                _dbg("Step 5: Writing DateTime to 0x2A08 ...")
                await client.write_gatt_char(DATETIME_CHAR, _datetime_payload(),
                                             response=True)
                _dbg("  DateTime written OK")

                # --- Step 6: Set memory buffer to 200 readings (cmd 0xA6) ---
                _dbg("Step 6: Configuring memory buffer ...")
                buffer_ok = False
                try:
                    await client.write_gatt_char(CUSTOM_CHAR, CMD_SET_BUFFER_200,
                                                 response=True)
                    _dbg("  Buffer size set to 200 readings (cmd 0xA6)")

                    # Verify by reading back
                    await client.write_gatt_char(CUSTOM_CHAR, CMD_READ_BUFFER,
                                                 response=True)
                    val = await client.read_gatt_char(CUSTOM_CHAR)
                    _dbg(f"  Buffer readback: {val.hex()} "
                         f"(expect ...D6 01 -> 200-data mode)")
                    buffer_ok = True
                except Exception as buf_err:
                    _dbg(f"  WARNING: buffer config failed: {_exc_detail(buf_err)}")
                    _dbg("  Offline readings may be lost without the 200-reading buffer.")

                # --- Step 7: Trust in BlueZ for future connections ---
                _dbg("Step 7: Trusting device in BlueZ ...")
                subprocess.run(
                    ["bluetoothctl", "trust", address],
                    capture_output=True, timeout=5, text=True, check=False,
                )
                _dbg("  Device trusted via bluetoothctl")

                _dbg("*** PAIRING COMPLETE ***")
                return {
                    "success": True,
                    "detail": "paired",
                    "buffer_configured": buffer_ok,
                    "bp_service": True,
                }

        except Exception as e:
            _dbg(f"BLE error: {_exc_detail(e)}")

            # Provide helpful guidance based on the error
            err_str = str(e).lower()
            if "timeout" in err_str:
                hint = (
                    "Connection timed out. This usually means the cuff's bond "
                    "memory was NOT cleared. Remove the cuff batteries for 30 "
                    "seconds, reinsert, hold START until 'Pr' blinks, then retry."
                )
            else:
                hint = f"BLE error: {_exc_detail(e)}"

            return {
                "success": False,
                "detail": hint,
            }

    finally:
        # Always clean up the agent process
        _stop_pairing_agent(agent_proc)


# ---------------------------------------------------------------------------
# CLI entry point — called by server.js via execFile
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="A&D UA-656BLE Provisioning")
    sub = parser.add_subparsers(dest="command")

    # scan subcommand
    scan_p = sub.add_parser("scan", help="Scan for BP monitors")
    scan_p.add_argument("--timeout", type=float, default=10.0)

    # pair subcommand
    pair_p = sub.add_parser("pair", help="Pair with a BP monitor")
    pair_p.add_argument("--address", required=True, help="BLE MAC address")
    pair_p.add_argument("--timeout", type=float, default=30.0)

    args = parser.parse_args()

    if args.command == "scan":
        try:
            devices = asyncio.run(scan_devices(timeout=args.timeout))
            print(json.dumps({"success": True, "devices": devices}))
        except Exception as e:
            _dbg(f"Scan exception: {_exc_detail(e)}")
            print(json.dumps({
                "success": False, "devices": [], "error": _exc_detail(e),
            }))

    elif args.command == "pair":
        try:
            result = asyncio.run(pair_device(
                address=args.address,
                timeout=args.timeout,
            ))
            print(json.dumps(result))
        except Exception as e:
            _dbg(f"Pair exception (outer): {_exc_detail(e)}")
            print(json.dumps({
                "success": False, "detail": f"pair error: {_exc_detail(e)}",
            }))

    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
