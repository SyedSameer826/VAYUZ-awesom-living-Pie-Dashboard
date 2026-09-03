#!/usr/bin/env python3
"""
glk_packet_capture.py — Diagnostic TCP listener for verifying GLK 0x4E packets.

Listens on port 8766, handles login/time-sync handshake so the device stays
connected, and logs every frame with hex dump. 0x4E sleep stage packets are
parsed and highlighted.

Usage on Pi:
    # First stop any existing listener on 8766
    sudo lsof -i :8766
    # If something is running, stop it first

    python3 glk_packet_capture.py

    # Let it run for 5-10 minutes. If the GLK device is paired and on the
    # same WiFi, it will connect and start sending frames.
    # Ctrl+C to stop.

Frame format (from GLK protocol V1.0.2.3):
    0x82 | length | ack | seq | cmd | payload... | xor_checksum

0x4E sleep stage byte layout:
    Byte 0: Response required (0x01)
    Byte 1: Sequence number
    Byte 2: Command (0x4E)
    Byte 3-6: Time offset (4 bytes)
    Byte 7: Heart rate
    Byte 8: Breathing rate
    Byte 9: Status (1=life_abnormal, 2=sleep_apnea, 3=in_bed, 4=out_bed, 5=snoring, 6=body_movement)
    Byte 10: Battery level
    Byte 11: Sleep stage (0=invalid, 1=awake, 2=light, 4=deep, 5=rem)
"""

import socket
import sys
import time
from datetime import datetime, timezone, timedelta

IST = timezone(timedelta(hours=5, minutes=30))

FRAME_START = 0x82

CMD_NAMES = {
    0x02: "TIME_SYNC",
    0x03: "LOGIN",
    0x04: "DEVICE_INFO",
    0x0D: "EMERGENCY",
    0x0E: "REALTIME",
    0x4E: "SLEEP_STAGE",
}

SLEEP_STAGES = {
    0: "invalid",
    1: "awake",
    2: "light_sleep",
    4: "deep_sleep",
    5: "rem",
}

STATUS_FLAGS = {
    1: "life_abnormality",
    2: "sleep_apnea",
    3: "in_bed",
    4: "out_of_bed",
    5: "snoring",
    6: "body_movement",
}

# counters
stats = {
    "total_frames": 0,
    "login": 0,
    "time_sync": 0,
    "device_info": 0,
    "realtime_0x0e": 0,
    "sleep_stage_0x4e": 0,
    "other": 0,
}


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


def sn_decode(b: bytes) -> str:
    return "".join(f"{x:02X}" for x in b)


def build_login_ack(seq: int) -> bytes:
    return build_frame(seq, 0x03, payload=b"\x5E\x09\x64\xB8")


def build_time_sync_ack(seq: int) -> bytes:
    now = datetime.now(IST)
    bcd = lambda n: int(f"{n:02d}", 16)
    payload = bytes([
        bcd(now.year % 100), bcd(now.month), bcd(now.day),
        bcd(now.hour), bcd(now.minute), bcd(now.second),
    ])
    return build_frame(seq, 0x02, payload=payload)


def build_device_info_ack(seq: int) -> bytes:
    return build_frame(seq, 0x04, payload=b"\x00")


def build_sleep_stage_ack(seq: int) -> bytes:
    """ACK for 0x4E: 82 05 00 00 4E 01 XX (per protocol doc)."""
    return build_frame(seq, 0x4E, payload=b"\x01", ack=0x00)


def build_realtime_ack(seq: int) -> bytes:
    return build_frame(seq, 0x0E, payload=b"\x01", ack=0x00)


def parse_frame(buf: bytes):
    """Try to parse one frame from the front of buf.
    Returns (parsed_dict, bytes_consumed) or (None, 0).
    """
    # find frame start
    idx = buf.find(bytes([FRAME_START]))
    if idx < 0:
        return None, len(buf)  # discard all
    if idx > 0:
        print(f"  [WARN] Skipping {idx} garbage bytes before 0x82")
        buf = buf[idx:]

    if len(buf) < 3:
        return None, 0  # need more data

    length = buf[1]
    total = 2 + length
    if len(buf) < total:
        return None, 0  # need more data

    frame_bytes = buf[:total]
    expected_cs = xor_checksum(frame_bytes[:-1])
    actual_cs = frame_bytes[-1]

    if expected_cs != actual_cs:
        print(f"  [WARN] Checksum mismatch: expected 0x{expected_cs:02X}, got 0x{actual_cs:02X}")
        return None, 1  # skip one byte, try again

    parsed = {
        "ack": frame_bytes[2],
        "seq": frame_bytes[3],
        "cmd": frame_bytes[4],
        "payload": frame_bytes[5:-1],
        "raw": frame_bytes,
    }
    return parsed, total


def parse_sleep_stage(payload: bytes) -> dict:
    """Parse 0x4E sleep stage payload bytes."""
    result = {}
    if len(payload) >= 4:
        # time offset is bytes 0-3 of payload (bytes 5-8 of frame)
        time_offset = int.from_bytes(payload[0:4], "big")
        result["time_offset"] = time_offset

    if len(payload) >= 5:
        result["heart_rate"] = payload[4]

    if len(payload) >= 6:
        result["breathing_rate"] = payload[5]

    if len(payload) >= 7:
        status_val = payload[6]
        result["status_raw"] = status_val
        result["status"] = STATUS_FLAGS.get(status_val, f"unknown({status_val})")

    if len(payload) >= 8:
        result["battery"] = payload[7]

    if len(payload) >= 9:
        stage_val = payload[8]
        result["sleep_stage_raw"] = stage_val
        result["sleep_stage"] = SLEEP_STAGES.get(stage_val, f"unknown({stage_val})")

    return result


def log(msg: str):
    ts = datetime.now(IST).strftime("%H:%M:%S.%f")[:-3]
    print(f"[{ts}] {msg}", flush=True)


def handle_client(conn: socket.socket, addr):
    log(f"=== GLK DEVICE CONNECTED from {addr[0]}:{addr[1]} ===")
    buf = b""
    conn.settimeout(120)  # 2 min timeout — device sends every ~60s

    try:
        while True:
            try:
                data = conn.recv(1024)
            except socket.timeout:
                log("Socket timeout (2 min no data) — device may have disconnected")
                break

            if not data:
                log("Connection closed by device")
                break

            buf += data
            log(f"Received {len(data)} bytes: {data.hex()}")

            while len(buf) >= 6:
                parsed, consumed = parse_frame(buf)
                if parsed is None:
                    if consumed == 0:
                        break  # need more data
                    buf = buf[consumed:]
                    continue

                buf = buf[consumed:]
                stats["total_frames"] += 1

                cmd = parsed["cmd"]
                seq = parsed["seq"]
                cmd_name = CMD_NAMES.get(cmd, f"UNKNOWN(0x{cmd:02X})")
                payload = parsed["payload"]

                log(f"FRAME #{stats['total_frames']}: cmd=0x{cmd:02X} ({cmd_name}) "
                    f"seq={seq} ack=0x{parsed['ack']:02X} "
                    f"payload[{len(payload)}]={payload.hex()}")

                # handle each command type
                if cmd == 0x03:  # LOGIN
                    stats["login"] += 1
                    sn = sn_decode(payload[:6]) if len(payload) >= 6 else "?"
                    log(f"  -> LOGIN from device SN={sn}")
                    ack = build_login_ack(seq)
                    conn.sendall(ack)
                    log(f"  <- LOGIN ACK sent: {ack.hex()}")

                elif cmd == 0x02:  # TIME_SYNC
                    stats["time_sync"] += 1
                    log(f"  -> TIME_SYNC request")
                    ack = build_time_sync_ack(seq)
                    conn.sendall(ack)
                    now_ist = datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S IST")
                    log(f"  <- TIME_SYNC ACK sent (current time: {now_ist}): {ack.hex()}")

                elif cmd == 0x04:  # DEVICE_INFO
                    stats["device_info"] += 1
                    raw = parsed["raw"]
                    sn = sn_decode(raw[5:11]) if len(raw) >= 11 else "?"
                    fw = raw[11:13].hex() if len(raw) >= 13 else "?"
                    log(f"  -> DEVICE_INFO: SN={sn}, firmware={fw}")
                    ack = build_device_info_ack(seq)
                    conn.sendall(ack)
                    log(f"  <- DEVICE_INFO ACK sent: {ack.hex()}")

                elif cmd == 0x0E:  # REALTIME
                    stats["realtime_0x0e"] += 1
                    log(f"  -> REALTIME (0x0E) data — per-second vitals")
                    # parse some basic fields if available
                    if len(payload) >= 5:
                        log(f"     heart_rate={payload[4] if len(payload) > 4 else '?'} "
                            f"breathing_rate={payload[5] if len(payload) > 5 else '?'}")
                    ack = build_realtime_ack(seq)
                    conn.sendall(ack)
                    log(f"  <- REALTIME ACK sent: {ack.hex()}")

                elif cmd == 0x4E:  # SLEEP_STAGE *** THE ONE WE'RE LOOKING FOR ***
                    stats["sleep_stage_0x4e"] += 1
                    parsed_stage = parse_sleep_stage(payload)
                    log("  ╔══════════════════════════════════════════════════════╗")
                    log("  ║  *** 0x4E SLEEP STAGE PACKET RECEIVED ***           ║")
                    log("  ╠══════════════════════════════════════════════════════╣")
                    for k, v in parsed_stage.items():
                        log(f"  ║  {k:20s} = {v}")
                    log(f"  ║  raw_payload = {payload.hex()}")
                    log(f"  ║  count so far = {stats['sleep_stage_0x4e']}")
                    log("  ╚══════════════════════════════════════════════════════╝")
                    # MUST send ACK or device may stop sending 0x4E
                    ack = build_sleep_stage_ack(seq)
                    conn.sendall(ack)
                    log(f"  <- SLEEP_STAGE ACK sent: {ack.hex()}")

                else:
                    stats["other"] += 1
                    log(f"  -> UNKNOWN cmd 0x{cmd:02X} — raw: {parsed['raw'].hex()}")

    except Exception as e:
        log(f"Error: {type(e).__name__}: {e}")
    finally:
        conn.close()
        log(f"=== CONNECTION CLOSED from {addr[0]}:{addr[1]} ===")
        print_stats()


def print_stats():
    log("--- CAPTURE STATISTICS ---")
    for k, v in stats.items():
        log(f"  {k:20s} = {v}")
    log(f"  ** sleep_stage_0x4e  = {stats['sleep_stage_0x4e']} **  {'CONFIRMED' if stats['sleep_stage_0x4e'] > 0 else 'NONE SEEN'}")
    log("--------------------------")


def main():
    port = 8766
    host = "0.0.0.0"

    log(f"GLK Packet Capture — listening on {host}:{port}")
    log(f"Waiting for GLK device to connect...")
    log(f"The device retries every ~60s, so wait at least 2 minutes.")
    log(f"Press Ctrl+C to stop.\n")

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)

    try:
        server.bind((host, port))
    except OSError as e:
        if "Address already in use" in str(e):
            log(f"ERROR: Port {port} is already in use!")
            log(f"Run: sudo lsof -i :{port}")
            log(f"Then stop whatever is using it before running this script.")
            sys.exit(1)
        raise

    server.listen(1)
    log(f"Listening on :{port} — ready for GLK device connection\n")

    try:
        while True:
            conn, addr = server.accept()
            handle_client(conn, addr)
    except KeyboardInterrupt:
        log("\nStopped by user (Ctrl+C)")
        print_stats()
    finally:
        server.close()


if __name__ == "__main__":
    main()
