#!/usr/bin/env python3
"""
glk_protocol.py  --  Awesom Living canonical reference for the GLK AI Smart
Sleep Monitor (WiFi-compact variant), Sleep-to-Cloud TCP protocol + BLE
provisioning.

Dependency-free (stdlib only). Verified against live packet captures.
Run `python3 glk_protocol.py --selftest` to confirm the frame logic is intact.

This is a verbatim copy of the GLK team's reference implementation, placed here
so glk_provision.py can import the verified BLE packet builders.
"""

from __future__ import annotations
import struct
from datetime import datetime, timezone

FRAME_START = 0x82

CMD_LOGIN        = 0x03
CMD_TIME_SYNC    = 0x02
CMD_DEVICE_INFO  = 0x04
CMD_REALTIME     = 0x0E
CMD_SLEEP_STAGE  = 0x4E
CMD_EMERGENCY    = 0x0D


def xor_checksum(data: bytes) -> int:
    c = 0
    for b in data:
        c ^= b
    return c


def build_frame(seq: int, cmd: int, payload: bytes = b"", ack: int = 0x01) -> bytes:
    body = bytes([ack & 0xFF, seq & 0xFF, cmd & 0xFF]) + payload
    length = len(body) + 1
    head = bytes([FRAME_START, length & 0xFF]) + body
    return head + bytes([xor_checksum(head)])


def parse_frame(frame: bytes):
    if len(frame) < 6 or frame[0] != FRAME_START:
        return None
    length = frame[1]
    total = 2 + length
    if len(frame) < total:
        return None
    frame = frame[:total]
    if xor_checksum(frame[:-1]) != frame[-1]:
        return None
    return {
        "ack": frame[2],
        "seq": frame[3],
        "cmd": frame[4],
        "payload": frame[5:-1],
        "checksum": frame[-1],
        "raw": frame,
    }


def sn_decode(b: bytes) -> str:
    return "".join(f"{x:02X}" for x in b)


def sn_encode(s: str) -> bytes:
    s = s.strip()
    if len(s) % 2:
        raise ValueError("SN must be an even number of digits")
    return bytes(int(s[i:i + 2], 16) for i in range(0, len(s), 2))


def parse_login(frame: dict) -> dict:
    p = frame["payload"]
    return {"sn": sn_decode(p[0:6]) if len(p) >= 6 else None}


def build_login_ack(seq: int, code: bytes = b"\x5E\x09\x64\xB8") -> bytes:
    if len(code) != 4:
        raise ValueError("login code must be exactly 4 bytes")
    return build_frame(seq, CMD_LOGIN, payload=code)


def parse_device_info(frame: dict) -> dict:
    raw = frame["raw"]
    if len(raw) < 18:
        return {}
    return {
        "sn": sn_decode(raw[5:11]),
        "firmware": raw[11:13].hex(),
        "verification_code": raw[13:17].hex(),
        "device_type": "wifi-compact",
    }


def build_device_info_ack(seq: int) -> bytes:
    return build_frame(seq, CMD_DEVICE_INFO, payload=b"\x00")


def build_time_sync_ack(seq: int, when=None) -> bytes:
    when = when or datetime.now(timezone.utc)
    bcd = lambda n: int(f"{n:02d}", 16)
    payload = bytes([
        bcd(when.year % 100), bcd(when.month), bcd(when.day),
        bcd(when.hour), bcd(when.minute), bcd(when.second),
    ])
    return build_frame(seq, CMD_TIME_SYNC, payload=payload)


# ===========================================================================
# BLE PROVISIONING  (one-time setup; sleep data does NOT come over BLE)
# ===========================================================================
BLE_SERVICE_UUID = "0000fff0-0000-1000-8000-00805f9b34fb"
BLE_WRITE_CHAR    = "0000fff1-0000-1000-8000-00805f9b34fb"  # app -> device
BLE_NOTIFY_CHAR   = "0000fff2-0000-1000-8000-00805f9b34fb"  # device -> app
BLE_FORBIDDEN     = ("fe59", "8ec9")  # NEVER write here (DFU bootloader)

BLE_MSG_WIFI   = 0x1F   # "<SSID>","<PASSWORD>"
BLE_MSG_SERVER = 0x23   # "<PI_IP>","<PORT>"


def ble_content(*values: str) -> bytes:
    return ",".join(f'"{v}"' for v in values).encode("ascii")


def build_ble_config(msg_type: int, *values: str) -> bytes:
    content = ble_content(*values)
    length = len(content) + 4
    return (bytes([0xCD, msg_type & 0xFF])
            + struct.pack(">H", length)
            + content
            + b"\xff\xff\xff\xff")


def chunk_ble(packet: bytes, size: int = 20):
    return [packet[i:i + size] for i in range(0, len(packet), size)]


def build_wifi_config(ssid: str, password: str):
    return chunk_ble(build_ble_config(BLE_MSG_WIFI, ssid, password))


def build_server_config(pi_ip: str, port: str = "8766"):
    return chunk_ble(build_ble_config(BLE_MSG_SERVER, pi_ip, str(port)))


def _selftest() -> int:
    ok = True

    def check(name, cond):
        nonlocal ok
        print(f"  [{'PASS' if cond else 'FAIL'}] {name}")
        ok = ok and cond

    login = bytes.fromhex("82 0A 01 A6 03 33 20 14 81 30 81 1B".replace(" ", ""))
    dinfo = bytes.fromhex("82 10 01 55 04 33 20 14 81 30 81 05 70 D6 00 00 00 56".replace(" ", ""))
    check("login checksum verifies", xor_checksum(login[:-1]) == login[-1])
    check("device-info checksum verifies", xor_checksum(dinfo[:-1]) == dinfo[-1])
    lf = parse_frame(login)
    df = parse_frame(dinfo)
    check("login SN == 332014813081", parse_login(lf)["sn"] == "332014813081")
    di = parse_device_info(df)
    check("device-info SN == 332014813081", di["sn"] == "332014813081")
    check("firmware == 0570", di["firmware"] == "0570")
    wifi = build_ble_config(BLE_MSG_WIFI, "AwesoHome_24G", "Awesom@2026")
    srv = build_ble_config(BLE_MSG_SERVER, "192.168.1.14", "8766")
    check("WiFi 0x1F length == 0x0021", wifi[2:4] == b"\x00\x21")
    check("server 0x23 length == 0x0019", srv[2:4] == b"\x00\x19")
    check("WiFi chunks into 2 writes", len(chunk_ble(wifi)) == 2)
    check("every chunk <= 20 bytes", all(len(c) <= 20 for c in chunk_ble(wifi) + chunk_ble(srv)))
    print("\nRESULT:", "ALL CHECKS PASSED" if ok else "FAILURES ABOVE")
    return 0 if ok else 1


if __name__ == "__main__":
    import sys
    if "--selftest" in sys.argv:
        raise SystemExit(_selftest())
    print(__doc__)
