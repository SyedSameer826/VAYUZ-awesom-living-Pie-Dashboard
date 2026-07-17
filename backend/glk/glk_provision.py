#!/usr/bin/env python3
"""
glk_provision.py -- BLE scan + provisioning CLI for the GLK sleep monitor,
used by the Pie platform's GLK pairing endpoints.

It reuses the VERIFIED packet builders in glk_protocol.py (do not re-derive
them) and uses `bleak` for the BLE transport (scan / connect / write / notify).

Usage (JSON is printed to stdout so Node can parse it):

  python3 glk_provision.py scan [--timeout 8]
    -> {"success": true, "devices": [{"name","serial","address"}, ...]}

  python3 glk_provision.py provision --address <ble-addr> \
      --ssid <2.4GHz SSID> --password <pwd> --pi-ip <pi lan ip> [--port 8766]
    -> {"success": true|false, "wifi_ack": bool, "server_ack": bool, "detail": "..."}

NOTES
-----
- The pad radio is 2.4 GHz ONLY -- the SSID must be a 2.4 GHz network.
- We write WiFi config (0x1F) first, wait for the success reply on fff2, then
  write the server config (0x23, = this Pi's IP + port 8766), and wait again.
- Success reply looks like `CD <msgType> 00 01 00 FF FF FF FF` (content byte 0x00).
  A failure reply has 0x01 in the content byte.
- Requires: pip install bleak  (and BlueZ on the Pi).

If you prefer to drive BLE with the GLK team's existing glk_ble_config.py, point
the Pie backend at it via the GLK_PROVISION_CMD env var instead of this file.
"""

from __future__ import annotations
import argparse
import asyncio
import json
import sys

import glk_protocol as glk

try:
    from bleak import BleakScanner, BleakClient
except Exception as e:  # bleak not installed / import failure
    print(json.dumps({"success": False, "error": f"bleak import failed: {e}"}))
    sys.exit(1)

ADV_PREFIX = "LZ-OTA"


def _out(obj) -> None:
    """Print a single JSON object to stdout and exit success."""
    print(json.dumps(obj))


async def do_scan(timeout: float) -> dict:
    found = await BleakScanner.discover(timeout=timeout)
    devices = []
    for d in found:
        name = (d.name or "").strip()
        if name.startswith(ADV_PREFIX):
            serial = name[len(ADV_PREFIX):].strip()
            devices.append({"name": name, "serial": serial, "address": d.address})
    return {"success": True, "devices": devices}


def _reply_is_success(data: bytes, msg_type: int) -> bool:
    # Reply envelope: CD | msgType(1) | length(2 BE) | content(n) | crc(4).
    # Success = content byte 0x00; failure = 0x01. Be lenient about msgType echo.
    if not data or len(data) < 5 or data[0] != 0xCD:
        return False
    return data[4] == 0x00


async def _write_chunks_and_wait(client, chunks, msg_type, timeout):
    got = {"data": None}
    ev = asyncio.Event()

    def on_notify(_char, data: bytearray):
        got["data"] = bytes(data)
        ev.set()

    await client.start_notify(glk.BLE_NOTIFY_CHAR, on_notify)
    try:
        for chunk in chunks:
            # BLE config writes are chunked to <= 20 bytes; write-without-response
            # matches the config characteristic behaviour.
            await client.write_gatt_char(glk.BLE_WRITE_CHAR, chunk, response=False)
            await asyncio.sleep(0.12)
        try:
            await asyncio.wait_for(ev.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            return False
        return _reply_is_success(got["data"], msg_type)
    finally:
        try:
            await client.stop_notify(glk.BLE_NOTIFY_CHAR)
        except Exception:
            pass


async def do_provision(address, ssid, password, pi_ip, port, timeout) -> dict:
    wifi_chunks = glk.build_wifi_config(ssid, password)
    server_chunks = glk.build_server_config(pi_ip, str(port))

    try:
        async with BleakClient(address, timeout=timeout) as client:
            wifi_ack = await _write_chunks_and_wait(
                client, wifi_chunks, glk.BLE_MSG_WIFI, timeout
            )
            # Small settle before the second config.
            await asyncio.sleep(0.3)
            server_ack = await _write_chunks_and_wait(
                client, server_chunks, glk.BLE_MSG_SERVER, timeout
            )
    except Exception as e:
        return {"success": False, "wifi_ack": False, "server_ack": False,
                "detail": f"BLE error: {e}"}

    success = bool(wifi_ack and server_ack)
    detail = "provisioned" if success else (
        "wifi config not acknowledged" if not wifi_ack
        else "server config not acknowledged"
    )
    return {"success": success, "wifi_ack": wifi_ack,
            "server_ack": server_ack, "detail": detail}


def main() -> None:
    parser = argparse.ArgumentParser(description="GLK BLE scan + provision")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_scan = sub.add_parser("scan")
    p_scan.add_argument("--timeout", type=float, default=8.0)

    p_prov = sub.add_parser("provision")
    p_prov.add_argument("--address", required=True)
    p_prov.add_argument("--ssid", required=True)
    p_prov.add_argument("--password", required=True)
    p_prov.add_argument("--pi-ip", required=True)
    p_prov.add_argument("--port", default="8766")
    p_prov.add_argument("--timeout", type=float, default=20.0)

    args = parser.parse_args()

    try:
        if args.cmd == "scan":
            result = asyncio.run(do_scan(args.timeout))
        else:
            result = asyncio.run(
                do_provision(args.address, args.ssid, args.password,
                             args.pi_ip, args.port, args.timeout)
            )
        _out(result)
    except Exception as e:
        _out({"success": False, "error": str(e)})
        sys.exit(1)


if __name__ == "__main__":
    main()
