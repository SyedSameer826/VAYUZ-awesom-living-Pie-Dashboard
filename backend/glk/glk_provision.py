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
import sys
import os

# Add the directory containing this script to the path so we can import glk_protocol
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import glk_protocol as glk


def _dbg(msg: str):
    """Print debug info to stderr so it doesn't pollute JSON stdout."""
    print(f"[GLK] {msg}", file=sys.stderr, flush=True)


def _result(success, wifi_ack=False, server_ack=False, detail=""):
    """Build a result dict that ALWAYS has all four expected fields."""
    return {
        "success": bool(success),
        "wifi_ack": bool(wifi_ack),
        "server_ack": bool(server_ack),
        "detail": str(detail),
    }


ADV_PREFIX = "LZ-OTA"


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
    from bleak import BleakClient

    # Build config packets INSIDE the try so failures get proper error format
    try:
        wifi_chunks = glk.build_wifi_config(ssid, password)
        server_chunks = glk.build_server_config(pi_ip, str(port))
    except Exception as e:
        _dbg(f"Config build failed: {e}")
        return _result(False, detail=f"config build error: {e}")

    _dbg(f"WiFi config: {len(wifi_chunks)} chunks, Server config: {len(server_chunks)} chunks")
    _dbg(f"Connecting to {address} (timeout={timeout}s) ...")

    try:
        async with BleakClient(address, timeout=timeout) as client:
            _dbg(f"Connected: {client.is_connected}")

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

            # Step 1: Write WiFi config (0x1F) and wait for ack
            _dbg("Step 1: Writing WiFi config ...")
            wifi_ack = await _write_chunks_and_wait(
                client, wifi_chunks, glk.BLE_MSG_WIFI, timeout, label="WiFi"
            )

            # Small settle before the second config
            await asyncio.sleep(0.3)

            # Step 2: Write server config (0x23) and wait for ack
            _dbg("Step 2: Writing server config ...")
            server_ack = await _write_chunks_and_wait(
                client, server_chunks, glk.BLE_MSG_SERVER, timeout, label="Server"
            )

    except Exception as e:
        _dbg(f"BLE error: {e}")
        return _result(False, detail=f"BLE error: {e}")

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
            _dbg(f"Scan exception: {e}")
            print(json.dumps({"success": False, "devices": [], "error": str(e)}))

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
            _dbg(f"Provision exception (outer): {e}")
            print(json.dumps(_result(False, detail=f"provision error: {e}")))

    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
