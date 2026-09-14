#!/usr/bin/env python3
"""
bp_provision.py — A&D UA-656BLE BLE scan & pairing for the Pi dashboard.

Called by server.js:
    POST /api/bp/scan   →  python3 bp_provision.py scan --timeout 10
    POST /api/bp/pair   →  python3 bp_provision.py pair --address <MAC>

Based directly on A&D's ad_pair.py reference with minimal additions
for production use (stale-bond cleanup, D-Bus agent, error handling).

Requirements:
    pip3 install --break-system-packages bleak

IMPORTANT:
    - The cuff supports only ONE bonded master. Never pair it to a phone.
    - After a successful pair, bp_bridge.py handles all subsequent reads.
    - The memory buffer config (cmd 0xA6 = 200 readings) is CRITICAL —
      without it, readings taken while the bridge is down may be lost.
    - ERR 10 = bond key mismatch. Fix: remove cuff batteries 30 seconds,
      reinsert, hold START until "Pr", then re-pair.
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
# BLE UUIDs & constants (from A&D spec)
# ---------------------------------------------------------------------------

DEVICE_NAME_PREFIX = "A&D_UA-656BLE"
BP_SERVICE_UUID = "00001810-0000-1000-8000-00805f9b34fb"
DATETIME_CHAR = "00002a08-0000-1000-8000-00805f9b34fb"
CUSTOM_CHAR = "233bf001-5a34-1b6d-975c-000d5690abe4"
CMD_SET_BUFFER_200 = bytes([0x03, 0x01, 0xA6, 0x02])
CMD_READ_BUFFER = bytes([0x02, 0x00, 0xD6])


def _dbg(msg: str):
    print(f"[BP] {msg}", file=sys.stderr, flush=True)


def _exc_detail(e: Exception) -> str:
    s = str(e)
    return f"{type(e).__name__}: {s}" if s else f"{type(e).__name__}: {e!r}"


def _datetime_payload() -> bytes:
    now = datetime.datetime.now()
    return struct.pack("<HBBBBB", now.year, now.month, now.day,
                       now.hour, now.minute, now.second)


# ---------------------------------------------------------------------------
# D-Bus pairing agent helper
# ---------------------------------------------------------------------------
def _start_agent():
    """Register a NoInputNoOutput BlueZ agent via a background bluetoothctl
    process. The agent stays alive as long as the process runs. This handles
    the case where the cuff sends a BLE Security Request during connection
    (before Bleak's own pair() registers its agent).
    """
    try:
        proc = subprocess.Popen(
            ["bluetoothctl"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        proc.stdin.write("agent NoInputNoOutput\n")
        proc.stdin.flush()
        time.sleep(0.3)
        proc.stdin.write("default-agent\n")
        proc.stdin.flush()
        time.sleep(0.3)
        _dbg(f"D-Bus agent registered (pid {proc.pid})")
        return proc
    except Exception as e:
        _dbg(f"Agent start failed (non-fatal): {_exc_detail(e)}")
        return None


def _stop_agent(proc):
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


# ---------------------------------------------------------------------------
# BLE Scan
# ---------------------------------------------------------------------------
async def scan_devices(timeout: float = 10.0) -> list[dict]:
    from bleak import BleakScanner

    _dbg(f"Scanning for A&D BP monitors ({timeout}s) ...")
    devices = []
    seen = set()

    discovered = await BleakScanner.discover(timeout=timeout, return_adv=True)
    _dbg(f"Scan done — {len(discovered)} BLE devices seen")

    for device, adv in discovered.values():
        name = adv.local_name or device.name or ""
        uuids = adv.service_uuids or []
        match_name = name.startswith(DEVICE_NAME_PREFIX)
        match_svc = any(BP_SERVICE_UUID.lower() in u.lower() for u in uuids)

        if (match_name or match_svc) and device.address not in seen:
            seen.add(device.address)
            devices.append({
                "address": device.address,
                "name": name or "BP Monitor",
                "rssi": adv.rssi,
            })
            _dbg(f"  Found: {name} @ {device.address} RSSI={adv.rssi}")

    _dbg(f"BP monitors found: {len(devices)}")
    return devices


# ---------------------------------------------------------------------------
# BLE Pair — follows ad_pair.py with stale-bond cleanup + D-Bus agent
# ---------------------------------------------------------------------------
async def pair_device(address: str, timeout: float = 30.0) -> dict:
    """
    Flow (based on A&D ad_pair.py reference):
      1. Clear Pi-side stale bond (bluetoothctl remove — NO service restart)
      2. Register D-Bus NoInputNoOutput agent (safety net for Security Request)
      3. Targeted scan for the device (detection callback, 30s)
      4. Connect (30s timeout)
      5. pair() — bond
      6. Write DateTime (0x2A08)
      7. Set memory buffer to 200 (cmd 0xA6)
      8. Trust in BlueZ
    """
    from bleak import BleakScanner, BleakClient

    _dbg(f"=== PAIR START for {address} ===")

    # --- 1. Clear Pi-side stale bond ---
    # ONLY bluetoothctl remove. Do NOT restart the bluetooth service —
    # that tears down the adapter and kills the scan.
    _dbg("Clearing Pi-side bond ...")
    subprocess.run(
        ["bluetoothctl", "untrust", address],
        capture_output=True, timeout=5, text=True, check=False,
    )
    subprocess.run(
        ["bluetoothctl", "remove", address],
        capture_output=True, timeout=5, text=True, check=False,
    )
    time.sleep(0.5)
    _dbg("Pi-side bond cleared")

    # --- 2. Register D-Bus agent ---
    agent = _start_agent()

    try:
        # --- 3. Targeted scan ---
        ble_device = None
        found = asyncio.Event()

        def _on_detect(dev, adv):
            nonlocal ble_device
            if dev.address.upper() == address.upper():
                ble_device = dev
                _dbg(f"TARGET FOUND: {adv.local_name or dev.name or address} "
                     f"RSSI={adv.rssi}")
                found.set()

        _dbg(f"Scanning for {address} (30s) ...")
        scanner = BleakScanner(detection_callback=_on_detect)
        await scanner.start()
        try:
            await asyncio.wait_for(found.wait(), timeout=30.0)
        except asyncio.TimeoutError:
            pass
        finally:
            await scanner.stop()

        if ble_device is None:
            _dbg("Device not found during scan")
            return {
                "success": False,
                "detail": (
                    f"BP monitor {address} not found during scan. "
                    "Make sure the cuff display shows 'Pr' (blinking). "
                    "If you see ERR 10 on the cuff, remove batteries for "
                    "30 seconds, reinsert, hold START ~3s until 'Pr', "
                    "then try again."
                ),
            }

        # --- 4. Connect ---
        _dbg(f"Connecting to {address} (30s timeout) ...")
        try:
            async with BleakClient(ble_device, timeout=30.0) as client:
                _dbg(f"CONNECTED to {address}")

                # --- 5. Bond ---
                try:
                    paired = await client.pair()
                    _dbg(f"pair(): {'OK' if paired else 'already bonded'}")
                except Exception as pe:
                    _dbg(f"pair() note: {_exc_detail(pe)} (often benign)")

                # --- 6. Write DateTime ---
                await client.write_gatt_char(
                    DATETIME_CHAR, _datetime_payload(), response=True)
                _dbg("DateTime written to 0x2A08")

                # --- 7. Set buffer to 200 readings ---
                buf_ok = False
                try:
                    await client.write_gatt_char(
                        CUSTOM_CHAR, CMD_SET_BUFFER_200, response=True)
                    _dbg("Buffer set to 200 (cmd 0xA6)")
                    await client.write_gatt_char(
                        CUSTOM_CHAR, CMD_READ_BUFFER, response=True)
                    val = await client.read_gatt_char(CUSTOM_CHAR)
                    _dbg(f"Buffer readback: {val.hex()}")
                    buf_ok = True
                except Exception as be:
                    _dbg(f"Buffer config failed: {_exc_detail(be)}")

                # --- 8. Trust ---
                subprocess.run(
                    ["bluetoothctl", "trust", address],
                    capture_output=True, timeout=5, text=True, check=False,
                )
                _dbg("Device trusted")

                _dbg("*** PAIRING COMPLETE ***")
                return {
                    "success": True,
                    "detail": "paired",
                    "buffer_configured": buf_ok,
                    "bp_service": True,
                }

        except Exception as e:
            detail = _exc_detail(e)
            _dbg(f"BLE error: {detail}")
            if "timeout" in detail.lower():
                return {
                    "success": False,
                    "detail": (
                        "Connection timed out — the cuff likely has stale "
                        "bond keys (ERR 10). Remove the cuff batteries for "
                        "30 seconds to clear its bond memory, reinsert, "
                        "hold START until 'Pr' blinks, then retry."
                    ),
                }
            return {"success": False, "detail": f"BLE error: {detail}"}

    finally:
        _stop_agent(agent)


# ---------------------------------------------------------------------------
# Combined Scan + Pair — eliminates Pr-mode timing gap
# ---------------------------------------------------------------------------
async def scan_and_pair(address: str, scan_timeout: float = 30.0) -> dict:
    """
    Combined scan-and-pair in a single operation.

    The cuff's Pr advertising window is short (~30-60 s). When scan and pair
    run as separate subprocess calls, the gap between them (user reaction
    time + bond clearing + agent setup) can exhaust the window before the
    pair's own scan starts.

    This function clears bonds, registers the agent, then starts scanning.
    The MOMENT the cuff is detected, it stops the scanner and immediately
    connects + pairs — zero wasted time.
    """
    from bleak import BleakScanner, BleakClient

    _dbg(f"=== SCAN+PAIR for {address} ===")

    # --- 1. Clear Pi-side stale bond (fast, no service restart) ---
    _dbg("Clearing Pi-side bond ...")
    subprocess.run(
        ["bluetoothctl", "untrust", address],
        capture_output=True, timeout=5, text=True, check=False,
    )
    subprocess.run(
        ["bluetoothctl", "remove", address],
        capture_output=True, timeout=5, text=True, check=False,
    )
    _dbg("Pi-side bond cleared")

    # --- 1b. Reset BLE adapter to clear stale state from prior attempts ---
    _dbg("Resetting BLE adapter ...")
    subprocess.run(
        ["bluetoothctl", "power", "off"],
        capture_output=True, timeout=5, text=True, check=False,
    )
    time.sleep(1)
    subprocess.run(
        ["bluetoothctl", "power", "on"],
        capture_output=True, timeout=5, text=True, check=False,
    )
    time.sleep(1)
    _dbg("BLE adapter reset")

    # --- 2. Register D-Bus agent ---
    agent = _start_agent()

    try:
        # --- 3. Targeted scan — callback fires the instant cuff is seen ---
        ble_device = None
        found = asyncio.Event()

        def _on_detect(dev, adv):
            nonlocal ble_device
            if dev.address.upper() == address.upper():
                ble_device = dev
                _dbg(f"TARGET FOUND: {adv.local_name or dev.name or address} "
                     f"RSSI={adv.rssi}")
                found.set()

        _dbg(f"Scanning for {address} ({scan_timeout}s) ...")
        scanner = BleakScanner(detection_callback=_on_detect)
        await scanner.start()
        try:
            await asyncio.wait_for(found.wait(), timeout=scan_timeout)
        except asyncio.TimeoutError:
            pass
        finally:
            await scanner.stop()

        if ble_device is None:
            _dbg("Device not found during scan")
            return {
                "success": False,
                "detail": (
                    f"BP monitor {address} not found. "
                    "Make sure the cuff display shows 'Pr' (blinking). "
                    "If you see ERR 10, remove batteries for 30 seconds, "
                    "reinsert, hold START ~3s until 'Pr', then try again."
                ),
            }

        # --- 4. Connect + pair (with one retry after adapter reset) ---
        MAX_CONNECT_TRIES = 2
        last_err = None

        for attempt in range(1, MAX_CONNECT_TRIES + 1):
            _dbg(f"Connect attempt {attempt}/{MAX_CONNECT_TRIES} "
                 f"to {address} (30s timeout) ...")
            try:
                async with BleakClient(ble_device, timeout=30.0) as client:
                    _dbg(f"CONNECTED to {address}")

                    # --- 5. Bond ---
                    try:
                        paired = await client.pair()
                        _dbg(f"pair(): {'OK' if paired else 'already bonded'}")
                    except Exception as pe:
                        _dbg(f"pair() note: {_exc_detail(pe)} (often benign)")

                    # --- 6. Write DateTime ---
                    await client.write_gatt_char(
                        DATETIME_CHAR, _datetime_payload(), response=True)
                    _dbg("DateTime written to 0x2A08")

                    # --- 7. Set buffer to 200 readings ---
                    buf_ok = False
                    try:
                        await client.write_gatt_char(
                            CUSTOM_CHAR, CMD_SET_BUFFER_200, response=True)
                        _dbg("Buffer set to 200 (cmd 0xA6)")
                        await client.write_gatt_char(
                            CUSTOM_CHAR, CMD_READ_BUFFER, response=True)
                        val = await client.read_gatt_char(CUSTOM_CHAR)
                        _dbg(f"Buffer readback: {val.hex()}")
                        buf_ok = True
                    except Exception as be:
                        _dbg(f"Buffer config failed: {_exc_detail(be)}")

                    # --- 8. Trust ---
                    subprocess.run(
                        ["bluetoothctl", "trust", address],
                        capture_output=True, timeout=5, text=True, check=False,
                    )
                    _dbg("Device trusted")

                    _dbg("*** PAIRING COMPLETE ***")
                    return {
                        "success": True,
                        "address": address,
                        "detail": "paired",
                        "buffer_configured": buf_ok,
                        "bp_service": True,
                    }

            except Exception as e:
                last_err = _exc_detail(e)
                _dbg(f"Connect attempt {attempt} failed: {last_err}")

                if attempt < MAX_CONNECT_TRIES:
                    # Reset adapter and re-scan briefly before retrying
                    _dbg("Resetting adapter before retry ...")
                    subprocess.run(
                        ["bluetoothctl", "power", "off"],
                        capture_output=True, timeout=5, text=True, check=False,
                    )
                    time.sleep(1)
                    subprocess.run(
                        ["bluetoothctl", "power", "on"],
                        capture_output=True, timeout=5, text=True, check=False,
                    )
                    time.sleep(1)

                    # Brief re-scan to re-acquire the device
                    ble_device = None
                    found = asyncio.Event()
                    _dbg("Re-scanning (10s) ...")
                    scanner2 = BleakScanner(detection_callback=_on_detect)
                    await scanner2.start()
                    try:
                        await asyncio.wait_for(found.wait(), timeout=10.0)
                    except asyncio.TimeoutError:
                        pass
                    finally:
                        await scanner2.stop()

                    if ble_device is None:
                        _dbg("Device lost after adapter reset")
                        break

        # All connect attempts exhausted
        if "timeout" in (last_err or "").lower():
            return {
                "success": False,
                "detail": (
                    "Connection timed out — the cuff may have stale "
                    "bond keys (ERR 10). Remove the cuff batteries for "
                    "30 seconds to clear its bond memory, reinsert, "
                    "hold START until 'Pr' blinks, then retry."
                ),
            }
        return {"success": False, "detail": f"BLE error: {last_err}"}

    finally:
        _stop_agent(agent)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="A&D UA-656BLE Provisioning")
    sub = parser.add_subparsers(dest="command")

    scan_p = sub.add_parser("scan")
    scan_p.add_argument("--timeout", type=float, default=10.0)

    pair_p = sub.add_parser("pair")
    pair_p.add_argument("--address", required=True)
    pair_p.add_argument("--timeout", type=float, default=30.0)

    scan_pair_p = sub.add_parser("scan_pair")
    scan_pair_p.add_argument("--address", required=True)
    scan_pair_p.add_argument("--timeout", type=float, default=30.0)

    args = parser.parse_args()

    if args.command == "scan":
        try:
            devs = asyncio.run(scan_devices(timeout=args.timeout))
            print(json.dumps({"success": True, "devices": devs}))
        except Exception as e:
            _dbg(f"Scan exception: {_exc_detail(e)}")
            print(json.dumps({
                "success": False, "devices": [], "error": _exc_detail(e),
            }))

    elif args.command == "pair":
        try:
            result = asyncio.run(pair_device(
                address=args.address, timeout=args.timeout))
            print(json.dumps(result))
        except Exception as e:
            _dbg(f"Pair exception: {_exc_detail(e)}")
            print(json.dumps({
                "success": False, "detail": f"pair error: {_exc_detail(e)}",
            }))

    elif args.command == "scan_pair":
        try:
            result = asyncio.run(scan_and_pair(
                address=args.address, scan_timeout=args.timeout))
            print(json.dumps(result))
        except Exception as e:
            _dbg(f"scan_pair exception: {_exc_detail(e)}")
            print(json.dumps({
                "success": False, "detail": f"scan_pair error: {_exc_detail(e)}",
            }))

    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
