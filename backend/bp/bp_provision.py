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

Pairing procedure (from A&D spec section 3.1):
    1. Hold the cuff's START button ~3 s until display blinks "Pr".
    2. Run this script (or trigger via the Pi dashboard "Pair BP" button).
    3. Script connects, bonds, writes DateTime, sets memory buffer to 200.
    4. Cuff display shows "End" when pairing completes.

IMPORTANT:
    - The cuff supports only ONE bonded master. Never pair it to a phone.
    - After a successful pair, bp_bridge.py handles all subsequent reads.
    - The memory buffer config (cmd 0xA6 = 200 readings) is CRITICAL —
      without it, readings taken while the bridge is down may be lost.
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
# BLE Pair — connect, bond, configure (based on A&D ad_pair.py)
# ---------------------------------------------------------------------------
async def pair_device(address: str, timeout: float = 15.0) -> dict:
    """Connect to a BP monitor, pair/bond, write DateTime, set buffer.

    This follows the A&D reference implementation (ad_pair.py):
    1. Targeted scan to find the device while it's advertising.
    2. Connect and pair/bond via Bleak.
    3. Write DateTime to 0x2A08 (required every connection).
    4. Set memory buffer to 200 readings via custom service (cmd 0xA6).
    5. Trust the device in BlueZ for future automatic connections.

    The cuff advertises for ~60s after pressing the Bluetooth button
    (or after entering Pr pairing mode).
    """
    from bleak import BleakScanner, BleakClient

    _dbg(f"=== PAIR START for {address} ===")

    # -------------------------------------------------------------------
    # Step 0: Clear stale BlueZ bond BEFORE scanning.
    # If the Pi has leftover bond keys from a previous pairing attempt
    # (or from the old provisioning code), BlueZ will try to reuse them
    # on connect. The cuff rejects the mismatched keys → ERR 10 → timeout.
    #
    # This is safe here because we haven't scanned yet — no BLEDevice
    # object exists to be destroyed. The targeted scan below picks up a
    # fresh device handle regardless of cache state.
    # -------------------------------------------------------------------
    _dbg(f"Clearing stale BlueZ state for {address} ...")
    subprocess.run(
        ["bluetoothctl", "untrust", address],
        capture_output=True, timeout=5, text=True, check=False,
    )
    subprocess.run(
        ["bluetoothctl", "remove", address],
        capture_output=True, timeout=5, text=True, check=False,
    )
    _dbg("Stale bond cleared (if any existed)")
    time.sleep(0.5)  # Let BlueZ settle

    # -------------------------------------------------------------------
    # Step 1: Targeted scan — find the device while it's advertising.
    # Uses a detection callback for instant response.
    # -------------------------------------------------------------------
    ble_device = None
    found_event = asyncio.Event()

    def _on_detect(device, adv_data):
        nonlocal ble_device
        if device.address.upper() == address.upper():
            ble_device = device
            name = adv_data.local_name or device.name or address
            _dbg(f"TARGET DETECTED: {name} RSSI={adv_data.rssi}")
            found_event.set()

    scan_timeout = 30.0
    _dbg(f"Scanning for {address} (up to {scan_timeout}s) ...")
    scanner = BleakScanner(detection_callback=_on_detect)
    await scanner.start()
    try:
        await asyncio.wait_for(found_event.wait(), timeout=scan_timeout)
    except asyncio.TimeoutError:
        _dbg(f"Timed out — {address} did not advertise in {scan_timeout}s")
    finally:
        await scanner.stop()

    if ble_device is None:
        _dbg(f"Device {address} never advertised — cannot connect")
        return {
            "success": False,
            "detail": (
                f"BP monitor {address} not found. "
                "Put the cuff in pairing mode (hold START ~3s until 'Pr' blinks) "
                "and try again."
            ),
        }

    # -------------------------------------------------------------------
    # Step 2: Connect and pair — based on A&D's ad_pair.py pattern.
    # Uses `async with BleakClient` for automatic cleanup.
    # -------------------------------------------------------------------
    connect_timeout = min(timeout, 15.0)
    _dbg(f"Connecting to {address} (timeout={connect_timeout}s) ...")

    try:
        async with BleakClient(ble_device, timeout=connect_timeout) as client:
            _dbg(f"CONNECTED to {address}")

            # --- Bond ---
            try:
                paired = await client.pair()
                _dbg(f"Pairing: {'OK' if paired else 'already bonded / not required'}")
            except Exception as pair_err:
                # "In Progress" or "AlreadyExists" errors are benign
                _dbg(f"pair() note: {_exc_detail(pair_err)} (often fine if bond exists)")

            # --- Write DateTime (0x2A08) — required every connection ---
            await client.write_gatt_char(DATETIME_CHAR, _datetime_payload(),
                                         response=True)
            _dbg("DateTime written to 0x2A08")

            # --- Set memory buffer to 200 readings (cmd 0xA6) ---
            buffer_ok = False
            try:
                await client.write_gatt_char(CUSTOM_CHAR, CMD_SET_BUFFER_200,
                                             response=True)
                _dbg("Buffer size set to 200 readings (cmd 0xA6)")

                # Verify by reading back
                await client.write_gatt_char(CUSTOM_CHAR, CMD_READ_BUFFER,
                                             response=True)
                val = await client.read_gatt_char(CUSTOM_CHAR)
                _dbg(f"Buffer readback: {val.hex()} (expect ...D6 01 -> 200-data mode)")
                buffer_ok = True
            except Exception as buf_err:
                _dbg(f"WARNING: buffer config failed: {_exc_detail(buf_err)}")
                _dbg("Offline readings may be lost without the 200-reading buffer.")

            # --- Trust in BlueZ for future connections ---
            subprocess.run(
                ["bluetoothctl", "trust", address],
                capture_output=True, timeout=5, text=True, check=False,
            )
            _dbg("Device trusted via bluetoothctl")

            _dbg("*** PAIRING COMPLETE ***")
            return {
                "success": True,
                "detail": "paired",
                "buffer_configured": buffer_ok,
                "bp_service": True,
            }

    except Exception as e:
        _dbg(f"BLE error: {_exc_detail(e)}")
        return {
            "success": False,
            "detail": f"BLE error: {_exc_detail(e)}",
        }


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
    pair_p.add_argument("--timeout", type=float, default=15.0)

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
