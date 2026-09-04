#!/usr/bin/env python3
"""
bp_provision.py — BLE scan & pairing for Bluetooth Blood Pressure monitors.

Called by server.js:
    POST /api/bp/scan   →  python3 bp_provision.py scan --timeout 10
    POST /api/bp/pair   →  python3 bp_provision.py pair --address <MAC>

Requirements:
    pip3 install bleak

Standard BLE Blood Pressure monitors advertise the Blood Pressure Service
(UUID 0x1810). We scan for devices exposing that service, then bond with the
chosen device so the Pi can later connect and read measurements.

Unlike the GLK sleep monitor (which needs WiFi provisioning), BP monitors
stay on BLE permanently — after bonding, the bp_bridge.py service connects
periodically to read stored measurements via indications on the Blood
Pressure Measurement characteristic (0x2A35).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
import sys
import os
import time


# Blood Pressure Service UUID (Bluetooth SIG assigned number 0x1810)
BP_SERVICE_UUID = "00001810-0000-1000-8000-00805f9b34fb"

# Blood Pressure Measurement characteristic (0x2A35) — indicate
BP_MEASUREMENT_CHAR = "00002a35-0000-1000-8000-00805f9b34fb"

# How many times to retry BLE connection before giving up
BLE_CONNECT_RETRIES = 3
BLE_RETRY_DELAY = 3.0  # seconds between retries


def _dbg(msg: str):
    """Print debug info to stderr so it doesn't pollute JSON stdout."""
    print(f"[BP] {msg}", file=sys.stderr, flush=True)


def _exc_detail(e: Exception) -> str:
    """Get a useful description of an exception."""
    s = str(e)
    if s:
        return f"{type(e).__name__}: {s}"
    return f"{type(e).__name__}: {e!r}"


# ---------------------------------------------------------------------------
# BlueZ adapter health check & stale connection cleanup
# ---------------------------------------------------------------------------
def _reset_bluetooth_adapter():
    """Reset the BlueZ adapter to clear stale state. Best-effort, never throws."""
    try:
        _dbg("Resetting Bluetooth adapter ...")
        hci_ok = subprocess.run(
            ["hciconfig", "hci0", "reset"],
            capture_output=True, timeout=5, check=False,
        )
        if hci_ok.returncode == 0:
            _dbg("Adapter reset via hciconfig hci0 reset")
            time.sleep(1.0)
        else:
            subprocess.run(
                ["bluetoothctl", "power", "off"],
                capture_output=True, timeout=5, check=False,
            )
            time.sleep(0.5)
            subprocess.run(
                ["bluetoothctl", "power", "on"],
                capture_output=True, timeout=5, check=False,
            )
            time.sleep(0.5)
            _dbg("Adapter power-cycled via bluetoothctl")
    except Exception as e:
        _dbg(f"Adapter reset (non-fatal): {_exc_detail(e)}")


def _remove_cached_device(address: str):
    """Remove a cached/stale BLE device from BlueZ so the next connect is fresh."""
    try:
        _dbg(f"Removing cached device {address} from BlueZ ...")
        result = subprocess.run(
            ["bluetoothctl", "remove", address],
            capture_output=True, timeout=5, text=True, check=False,
        )
        _dbg(f"  remove result: {result.stdout.strip()} / {result.stderr.strip()}")
    except Exception as e:
        _dbg(f"  remove cached device (non-fatal): {_exc_detail(e)}")


def _check_adapter_health() -> bool:
    """Check that the BlueZ adapter is powered on and ready."""
    try:
        result = subprocess.run(
            ["bluetoothctl", "show"],
            capture_output=True, timeout=5, text=True, check=False,
        )
        output = result.stdout
        powered = "Powered: yes" in output
        if not powered:
            _dbg("WARNING: Adapter is NOT powered on, attempting to power on ...")
            subprocess.run(
                ["bluetoothctl", "power", "on"],
                capture_output=True, timeout=5, check=False,
            )
            time.sleep(0.5)
            result2 = subprocess.run(
                ["bluetoothctl", "show"],
                capture_output=True, timeout=5, text=True, check=False,
            )
            powered = "Powered: yes" in result2.stdout
            _dbg(f"After power-on attempt: Powered={'yes' if powered else 'NO'}")
        return powered
    except Exception as e:
        _dbg(f"Adapter health check (non-fatal): {_exc_detail(e)}")
        return True  # Assume OK if we can't check


# ---------------------------------------------------------------------------
# BLE Scan — find BP monitors advertising Blood Pressure Service (0x1810)
# ---------------------------------------------------------------------------
async def scan_devices(timeout: float = 10.0) -> list[dict]:
    from bleak import BleakScanner

    _dbg(f"Starting BLE scan for BP monitors (timeout={timeout}s) ...")
    devices = []
    discovered = await BleakScanner.discover(timeout=timeout, return_adv=True)
    _dbg(f"Scan complete — {len(discovered)} total BLE devices seen")

    for device, adv_data in discovered.values():
        # Check if device advertises the Blood Pressure Service
        service_uuids = adv_data.service_uuids or []
        has_bp_service = any(
            BP_SERVICE_UUID.lower() in uuid.lower()
            for uuid in service_uuids
        )

        if has_bp_service:
            name = adv_data.local_name or device.name or "BP Monitor"
            devices.append({
                "address": device.address,
                "name": name,
                "rssi": adv_data.rssi,
            })
            _dbg(f"  Found BP monitor: {name} @ {device.address} (RSSI {adv_data.rssi})")

    _dbg(f"BP monitors found: {len(devices)}")
    return devices


# ---------------------------------------------------------------------------
# Pre-connect: verify device is still advertising
# ---------------------------------------------------------------------------
async def _verify_device_present(address: str, timeout: float = 5.0):
    """Quick scan to confirm the target device is still advertising."""
    from bleak import BleakScanner

    _dbg(f"Pre-connect scan: verifying {address} is still advertising ({timeout}s) ...")
    try:
        discovered = await BleakScanner.discover(timeout=timeout, return_adv=True)
        for device, _adv in discovered.values():
            if device.address.upper() == address.upper():
                _dbg(f"Pre-connect scan: device {address} confirmed present (RSSI {_adv.rssi})")
                return True, device
        _dbg(f"Pre-connect scan: device {address} NOT found among {len(discovered)} devices")
        return False, None
    except Exception as e:
        _dbg(f"Pre-connect scan (non-fatal): {_exc_detail(e)}")
        return True, None  # Optimistic — proceed to connect attempt anyway


# ---------------------------------------------------------------------------
# BLE Connect with retries
# ---------------------------------------------------------------------------
async def _connect_with_retries(address_or_device, timeout: float):
    """Try to connect to the BLE device, retrying on failure."""
    from bleak import BleakClient

    target = address_or_device
    address = getattr(target, "address", target)

    last_exc = None
    for attempt in range(1, BLE_CONNECT_RETRIES + 1):
        try:
            _dbg(f"Connection attempt {attempt}/{BLE_CONNECT_RETRIES} to {address} ...")
            client = BleakClient(target, timeout=timeout)
            await client.connect()
            if client.is_connected:
                _dbg(f"Connected on attempt {attempt}: {client.is_connected}")
                return client
            else:
                raise RuntimeError("connect() succeeded but is_connected is False")
        except Exception as e:
            last_exc = e
            _dbg(f"Attempt {attempt} FAILED: {_exc_detail(e)}")
            try:
                await client.disconnect()
            except Exception:
                pass

            if attempt < BLE_CONNECT_RETRIES:
                _dbg(f"Clearing BlueZ cache for {address} and retrying in {BLE_RETRY_DELAY}s ...")
                _remove_cached_device(address)
                await asyncio.sleep(BLE_RETRY_DELAY)

    raise last_exc


# ---------------------------------------------------------------------------
# BLE Pair — connect and verify the BP service is present, then bond
# ---------------------------------------------------------------------------
async def pair_device(address: str, timeout: float = 15.0) -> dict:
    """Connect to a BP monitor and verify its Blood Pressure Service.

    BlueZ handles bonding automatically when the device requires it during
    GATT discovery. After a successful connect + service discovery, the
    device is bonded and can be reconnected by bp_bridge.py for readings.
    """

    # Pre-flight: adapter health check
    adapter_ok = _check_adapter_health()
    if not adapter_ok:
        _dbg("Adapter health check failed — attempting reset before connecting")
        _reset_bluetooth_adapter()

    # Do NOT remove the cached device on the first attempt — BlueZ may still
    # have the D-Bus object from the scan that just ran. Removing it forces a
    # fresh discovery, but the BP monitor may have stopped advertising by now.
    # Instead, try to connect using whatever BlueZ already knows first.

    # Quick re-scan to grab a fresh BLEDevice object (helps bleak resolve the
    # D-Bus path). Use 8s so the monitor has time to advertise again.
    device_present, ble_device = await _verify_device_present(address, timeout=8.0)
    if not device_present:
        _dbg("WARNING: device not seen in pre-connect scan — will still attempt connect")

    connect_target = ble_device if ble_device else address
    connect_timeout = min(timeout, 15.0)

    client = None
    try:
        client = await _connect_with_retries(connect_target, connect_timeout)

        # Log discovered services
        bp_service_found = False
        bp_measurement_found = False
        for service in client.services:
            _dbg(f"  Service: {service.uuid}")
            if BP_SERVICE_UUID.lower() in service.uuid.lower():
                bp_service_found = True
            for char in service.characteristics:
                props = ", ".join(char.properties)
                _dbg(f"    Char: {char.uuid} [{props}]")
                if BP_MEASUREMENT_CHAR.lower() in char.uuid.lower():
                    bp_measurement_found = True

        if not bp_service_found:
            _dbg("FATAL: Blood Pressure Service (0x1810) not found on device!")
            return {
                "success": False,
                "detail": "Device does not have Blood Pressure Service (0x1810)",
            }

        if not bp_measurement_found:
            _dbg("WARNING: BP Measurement characteristic (0x2A35) not found — "
                 "device may still work with different firmware")

        # Try to pair/bond via bluetoothctl for persistent bonding
        _dbg(f"Requesting BlueZ bond with {address} ...")
        bond_result = subprocess.run(
            ["bluetoothctl", "pair", address],
            capture_output=True, timeout=15, text=True, check=False,
        )
        _dbg(f"  pair result: {bond_result.stdout.strip()} / {bond_result.stderr.strip()}")

        # Trust the device so BlueZ auto-connects in future
        subprocess.run(
            ["bluetoothctl", "trust", address],
            capture_output=True, timeout=5, text=True, check=False,
        )

        _dbg("*** BP MONITOR PAIRING COMPLETE ***")
        return {
            "success": True,
            "detail": "paired",
            "bp_service": bp_service_found,
            "bp_measurement": bp_measurement_found,
        }

    except Exception as e:
        _dbg(f"BLE error: {_exc_detail(e)}")
        return {
            "success": False,
            "detail": f"BLE error: {_exc_detail(e)}",
        }
    finally:
        if client:
            try:
                await client.disconnect()
                _dbg("Disconnected from device")
            except Exception:
                pass


# ---------------------------------------------------------------------------
# CLI entry point — called by server.js via execFile
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="BP Monitor BLE Provisioning")
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
            print(json.dumps({"success": False, "devices": [], "error": _exc_detail(e)}))

    elif args.command == "pair":
        try:
            result = asyncio.run(pair_device(
                address=args.address,
                timeout=args.timeout,
            ))
            print(json.dumps(result))
        except Exception as e:
            _dbg(f"Pair exception (outer): {_exc_detail(e)}")
            print(json.dumps({"success": False, "detail": f"pair error: {_exc_detail(e)}"}))

    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
