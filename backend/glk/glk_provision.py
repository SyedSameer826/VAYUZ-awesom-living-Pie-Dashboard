#!/usr/bin/env python3
"""
glk_provision.py — BLE scan & provisioning for the GLK AI Smart Sleep Monitor.

Called by server.js:
    POST /api/glk/scan     →  python3 glk_provision.py scan --timeout 8
    POST /api/glk/pair     →  python3 glk_provision.py provision \
                                  --address <MAC> --ssid <SSID> --password <PWD> \
                                  --pi-ip <IP> --port 8766

Requirements:
    pip3 install bleak

The device advertises as "LZ-OTA <12-digit serial>" on BLE. We scan for that
prefix, then write WiFi (0x1F) and server (0x23) config packets to GATT
characteristic fff1, subscribing to fff2 for the device's reply.

After provisioning, the device joins the given 2.4 GHz WiFi and streams sleep
data over TCP to the Pi on the configured port. BLE is NOT used again.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
import sys
import os
import time

# Add the directory containing this script to the path so we can import glk_protocol
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import glk_protocol as glk


def _dbg(msg: str):
    """Print debug info to stderr so it doesn't pollute JSON stdout."""
    print(f"[GLK] {msg}", file=sys.stderr, flush=True)


def _exc_detail(e: Exception) -> str:
    """Get a useful description of an exception, even when str(e) is empty.
    bleak/BlueZ D-Bus errors often have empty str() but meaningful repr().
    """
    s = str(e)
    if s:
        return f"{type(e).__name__}: {s}"
    return f"{type(e).__name__}: {e!r}"


def _result(success, wifi_ack=False, server_ack=False, detail=""):
    """Build a result dict that ALWAYS has all four expected fields."""
    return {
        "success": bool(success),
        "wifi_ack": bool(wifi_ack),
        "server_ack": bool(server_ack),
        "detail": str(detail),
    }


ADV_PREFIX = "LZ-OTA"

# How many times to retry BLE connection before giving up
BLE_CONNECT_RETRIES = 3
BLE_RETRY_DELAY = 3.0  # seconds between retries (BlueZ D-Bus needs time to settle)


# ---------------------------------------------------------------------------
# BlueZ adapter health check & stale connection cleanup
# ---------------------------------------------------------------------------
def _reset_bluetooth_adapter():
    """Reset the BlueZ adapter to clear stale state. Best-effort, never throws."""
    try:
        _dbg("Resetting Bluetooth adapter ...")
        # Try hciconfig reset first — more reliable on Raspberry Pi than
        # bluetoothctl power cycling, especially after a scan
        hci_ok = subprocess.run(
            ["hciconfig", "hci0", "reset"],
            capture_output=True, timeout=5, check=False,
        )
        if hci_ok.returncode == 0:
            _dbg("Adapter reset via hciconfig hci0 reset")
            time.sleep(1.0)
        else:
            # Fall back to bluetoothctl power cycle
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
        _dbg(f"Adapter info:\n{output.strip()}")
        powered = "Powered: yes" in output
        if not powered:
            _dbg("WARNING: Adapter is NOT powered on, attempting to power on ...")
            subprocess.run(
                ["bluetoothctl", "power", "on"],
                capture_output=True, timeout=5, check=False,
            )
            time.sleep(0.5)
            # Re-check
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
# BLE Scan — find GLK devices advertising as "LZ-OTA ..."
# ---------------------------------------------------------------------------
async def scan_devices(timeout: float = 8.0) -> list[dict]:
    from bleak import BleakScanner

    _dbg(f"Starting BLE scan (timeout={timeout}s) ...")
    devices = []
    discovered = await BleakScanner.discover(timeout=timeout, return_adv=True)
    _dbg(f"Scan complete — {len(discovered)} total BLE devices seen")

    for device, adv_data in discovered.values():
        name = adv_data.local_name or device.name or ""
        if name.startswith(ADV_PREFIX):
            serial = name[len(ADV_PREFIX):].strip()
            devices.append({
                "address": device.address,
                "name": name,
                "serial": serial,
                "rssi": adv_data.rssi,
            })
            _dbg(f"  Found GLK device: {name} @ {device.address} (RSSI {adv_data.rssi})")

    _dbg(f"GLK devices found: {len(devices)}")
    return devices


# ---------------------------------------------------------------------------
# Helper: reply success check
# ---------------------------------------------------------------------------
def _reply_is_success(data: bytes, msg_type: int) -> bool:
    """Check if the BLE reply indicates success.
    Reply envelope: CD | msgType(1) | length(2 BE) | content(n) | crc(4).
    Success = content byte 0x00; failure = 0x01.
    """
    if not data or len(data) < 5 or data[0] != 0xCD:
        _dbg(f"  Reply check: invalid envelope (len={len(data) if data else 0})")
        return False
    actual_type = data[1]
    content_byte = data[4]
    _dbg(f"  Reply check: type=0x{actual_type:02X} content=0x{content_byte:02X} "
         f"({'SUCCESS' if content_byte == 0x00 else 'FAIL'})")
    return content_byte == 0x00


# ---------------------------------------------------------------------------
# Helper: write chunks and wait for reply
# ---------------------------------------------------------------------------
async def _write_chunks_and_wait(client, chunks, msg_type, timeout, label=""):
    """Write BLE config chunks to fff1, subscribe to fff2 for the reply."""
    got = {"data": None}
    ev = asyncio.Event()

    def on_notify(_char, data: bytearray):
        got["data"] = bytes(data)
        _dbg(f"  [{label}] Reply on fff2: {data.hex()} ({len(data)} bytes)")
        ev.set()

    _dbg(f"  [{label}] Subscribing to notifications on {glk.BLE_NOTIFY_CHAR} ...")
    await client.start_notify(glk.BLE_NOTIFY_CHAR, on_notify)
    try:
        for i, chunk in enumerate(chunks):
            _dbg(f"  [{label}] Writing chunk {i+1}/{len(chunks)}: {chunk.hex()}")
            await client.write_gatt_char(glk.BLE_WRITE_CHAR, chunk, response=False)
            await asyncio.sleep(0.12)
        _dbg(f"  [{label}] All {len(chunks)} chunks written, waiting for reply ({timeout}s) ...")
        try:
            await asyncio.wait_for(ev.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            _dbg(f"  [{label}] TIMEOUT — no reply from device")
            return False
        return _reply_is_success(got["data"], msg_type)
    finally:
        try:
            await client.stop_notify(glk.BLE_NOTIFY_CHAR)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Pre-connect: verify device is still advertising (warms up the adapter)
# ---------------------------------------------------------------------------
async def _verify_device_present(address: str, timeout: float = 5.0) -> bool:
    """Quick scan to confirm the target device is still advertising.
    Also serves to transition the BlueZ adapter from idle/stale state into
    active mode, which makes the subsequent connect more reliable.
    """
    from bleak import BleakScanner

    _dbg(f"Pre-connect scan: verifying {address} is still advertising ({timeout}s) ...")
    try:
        discovered = await BleakScanner.discover(timeout=timeout, return_adv=True)
        for device, _adv in discovered.values():
            if device.address.upper() == address.upper():
                _dbg(f"Pre-connect scan: device {address} confirmed present (RSSI {_adv.rssi})")
                return True
        _dbg(f"Pre-connect scan: device {address} NOT found among {len(discovered)} devices")
        return False
    except Exception as e:
        _dbg(f"Pre-connect scan (non-fatal): {_exc_detail(e)}")
        return True  # Optimistic — proceed to connect attempt anyway


# ---------------------------------------------------------------------------
# BLE Connect with retries
# ---------------------------------------------------------------------------
async def _connect_with_retries(address: str, timeout: float):
    """Try to connect to the BLE device, retrying on failure.
    Returns a connected BleakClient or raises the last exception.
    """
    from bleak import BleakClient

    last_exc = None
    for attempt in range(1, BLE_CONNECT_RETRIES + 1):
        try:
            _dbg(f"Connection attempt {attempt}/{BLE_CONNECT_RETRIES} to {address} ...")
            client = BleakClient(address, timeout=timeout)
            await client.connect()
            if client.is_connected:
                _dbg(f"Connected on attempt {attempt}: {client.is_connected}")
                return client
            else:
                _dbg(f"Attempt {attempt}: client.connect() returned but is_connected=False")
                raise RuntimeError("connect() succeeded but is_connected is False")
        except Exception as e:
            last_exc = e
            _dbg(f"Attempt {attempt} FAILED: {_exc_detail(e)}")
            # Try to disconnect cleanly if partially connected
            try:
                await client.disconnect()
            except Exception:
                pass

            if attempt < BLE_CONNECT_RETRIES:
                _dbg(f"Clearing BlueZ cache for {address} and retrying in {BLE_RETRY_DELAY}s ...")
                _remove_cached_device(address)
                await asyncio.sleep(BLE_RETRY_DELAY)

    # All attempts exhausted
    raise last_exc


# ---------------------------------------------------------------------------
# BLE Provision — write WiFi + server config to the device
# ---------------------------------------------------------------------------
async def provision_device(
    address: str,
    ssid: str,
    password: str,
    pi_ip: str,
    port: str = "8766",
    timeout: float = 20.0,
) -> dict:
    """Connect to a GLK device and write WiFi + server config over BLE."""

    # Build config packets INSIDE the try so failures get proper error format
    try:
        wifi_chunks = glk.build_wifi_config(ssid, password)
        server_chunks = glk.build_server_config(pi_ip, str(port))
    except Exception as e:
        _dbg(f"Config build failed: {_exc_detail(e)}")
        return _result(False, detail=f"config build error: {_exc_detail(e)}")

    _dbg(f"WiFi config: {len(wifi_chunks)} chunks, Server config: {len(server_chunks)} chunks")

    # ------------------------------------------------------------------
    # Pre-flight: adapter health check, stale cache cleanup, and a quick
    # verification scan.  This sequence transitions BlueZ from whatever
    # state the previous /api/glk/scan left it in into a clean state
    # ready for a GATT connection.
    # ------------------------------------------------------------------
    adapter_ok = _check_adapter_health()
    if not adapter_ok:
        _dbg("Adapter health check failed — attempting reset before connecting")
        _reset_bluetooth_adapter()

    _remove_cached_device(address)

    # Quick re-scan to (a) verify the device is still advertising and
    # (b) warm up the BlueZ adapter — significantly improves connect
    # reliability after a fresh scan-then-provision sequence.
    device_present = await _verify_device_present(address, timeout=5.0)
    if not device_present:
        _dbg("WARNING: device not seen in pre-connect scan — will still attempt connect")

    # Clear cache again after the verification scan (scan may re-populate it)
    _remove_cached_device(address)

    # Per-attempt connection timeout.  Keep this shorter than the overall
    # child-process limit (90 s in server.js) so retries have room.
    connect_timeout = min(timeout, 15.0)
    _dbg(f"Connecting to {address} (per-attempt timeout={connect_timeout}s) ...")

    client = None
    try:
        client = await _connect_with_retries(address, connect_timeout)

        # Log discovered services for debugging
        for service in client.services:
            _dbg(f"  Service: {service.uuid}")
            for char in service.characteristics:
                props = ", ".join(char.properties)
                _dbg(f"    Char: {char.uuid} [{props}]")

        # Verify the required characteristics exist before writing
        write_char = None
        notify_char = None
        for service in client.services:
            for char in service.characteristics:
                if char.uuid == glk.BLE_WRITE_CHAR:
                    write_char = char
                if char.uuid == glk.BLE_NOTIFY_CHAR:
                    notify_char = char

        if not write_char:
            _dbg(f"FATAL: Write characteristic {glk.BLE_WRITE_CHAR} not found on device!")
            return _result(False, detail=f"BLE error: write characteristic fff1 not found on device")
        if not notify_char:
            _dbg(f"FATAL: Notify characteristic {glk.BLE_NOTIFY_CHAR} not found on device!")
            return _result(False, detail=f"BLE error: notify characteristic fff2 not found on device")

        _dbg(f"Characteristics verified: fff1=[{', '.join(write_char.properties)}] "
             f"fff2=[{', '.join(notify_char.properties)}]")

        # GATT reply timeout — much shorter than connection timeout;
        # the device responds within a second or two when config is accepted.
        write_timeout = 10.0

        # Step 1: Write WiFi config (0x1F) and wait for ack
        _dbg("Step 1: Writing WiFi config ...")
        wifi_ack = await _write_chunks_and_wait(
            client, wifi_chunks, glk.BLE_MSG_WIFI, write_timeout, label="WiFi"
        )

        # Small settle before the second config
        await asyncio.sleep(0.3)

        # Step 2: Write server config (0x23) and wait for ack
        _dbg("Step 2: Writing server config ...")
        server_ack = await _write_chunks_and_wait(
            client, server_chunks, glk.BLE_MSG_SERVER, write_timeout, label="Server"
        )

    except Exception as e:
        _dbg(f"BLE error: {_exc_detail(e)}")
        return _result(False, detail=f"BLE error: {_exc_detail(e)}")
    finally:
        # Always try to disconnect cleanly
        if client:
            try:
                await client.disconnect()
                _dbg("Disconnected from device")
            except Exception:
                pass

    success = bool(wifi_ack and server_ack)
    detail = "provisioned" if success else (
        "wifi config not acknowledged" if not wifi_ack
        else "server config not acknowledged"
    )
    _dbg(f"Result: success={success}, wifi_ack={wifi_ack}, server_ack={server_ack}, detail={detail}")
    if success:
        _dbg("*** PROVISIONING COMPLETE ***")

    return _result(success, wifi_ack=wifi_ack, server_ack=server_ack, detail=detail)


# ---------------------------------------------------------------------------
# CLI entry point — called by server.js via execFile
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="GLK BLE Provisioning")
    sub = parser.add_subparsers(dest="command")

    # scan subcommand
    scan_p = sub.add_parser("scan", help="Scan for GLK devices")
    scan_p.add_argument("--timeout", type=float, default=8.0)

    # provision subcommand
    prov_p = sub.add_parser("provision", help="Provision a GLK device")
    prov_p.add_argument("--address", required=True, help="BLE MAC address")
    prov_p.add_argument("--ssid", required=True, help="WiFi SSID (must be 2.4 GHz)")
    prov_p.add_argument("--password", required=True, help="WiFi password")
    prov_p.add_argument("--pi-ip", required=True, help="Pi's reserved IP address")
    prov_p.add_argument("--port", default="8766", help="TCP port (default 8766)")
    prov_p.add_argument("--timeout", type=float, default=20.0)

    args = parser.parse_args()

    if args.command == "scan":
        try:
            devices = asyncio.run(scan_devices(timeout=args.timeout))
            print(json.dumps({"success": True, "devices": devices}))
        except Exception as e:
            _dbg(f"Scan exception: {_exc_detail(e)}")
            print(json.dumps({"success": False, "devices": [], "error": _exc_detail(e)}))

    elif args.command == "provision":
        try:
            result = asyncio.run(provision_device(
                address=args.address,
                ssid=args.ssid,
                password=args.password,
                pi_ip=args.pi_ip,
                port=args.port,
                timeout=args.timeout,
            ))
            print(json.dumps(result))
        except Exception as e:
            # CRITICAL: Always include ALL expected fields so server.js
            # never gets a response missing wifi_ack/server_ack/detail
            _dbg(f"Provision exception (outer): {_exc_detail(e)}")
            print(json.dumps(_result(False, detail=f"provision error: {_exc_detail(e)}")))

    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
