#!/usr/bin/env python3
"""
glk_bridge.py — TCP bridge for the GLK AI Smart Sleep Monitor.

Listens on TCP port 8766. When a GLK device connects (after BLE provisioning),
it handles the full handshake (login → time sync → device info) and then
receives ~1 Hz realtime vitals, forwarding them to the Awesom Living backend.

Architecture:
    GLK pad  ──WiFi 2.4GHz──▶  This bridge (TCP :8766)  ──▶  Backend (MongoDB)

This script uses glk_protocol.py for all frame parsing/building. The 0x0E
realtime decode offsets were verified on the wire and must NOT be re-derived
from the PDF.

v20: All 13 raw device fields now forwarded (added signal_quality).
     Emergency frames forward decoded fields instead of raw hex.
v23: 0x4E sleep stage — parse HR/RR/status/battery/stage, send ACK
     so device keeps sending, forward structured data to backend.
     Verified against live 0x4E packet from firmware v0570 on 2026-09-03.
v24: Forward ALL device data to backend — nothing stays log-only anymore.
     - Device Info (0x04): firmware, device_type, verification_code now POSTed.
     - Connection lifecycle: device_connected + device_disconnected events.
     - Emergency (0x0D): parse actual payload instead of hardcoding nulls.
     - Session stats (realtime_count, sleep_stage_count, duration) in disconnect.

Run as a systemd service:
    [Service]
    ExecStart=/usr/bin/python3 /home/pi/VAYUZ-awesom-living-Pie-Dashboard/backend/glk/glk_bridge.py
    Restart=always

Debug knobs (environment variables):
    GLK_TIME_FORMAT=bcd|binary|epoch  — switch Time Sync ACK payload format
    GLK_SKIP_TIME_ACK=1               — don't reply to Time Sync at all (test)
    GLK_LOG_LEVEL=DEBUG                — show non-frame bytes and extra detail
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import socket
import struct
import sys
import time
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.error import URLError

# Add this script's directory to path for glk_protocol import
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from glk_protocol import (
    FRAME_START,
    CMD_LOGIN,
    CMD_TIME_SYNC,
    CMD_DEVICE_INFO,
    CMD_REALTIME,
    CMD_SLEEP_STAGE,
    CMD_EMERGENCY,
    parse_frame,
    parse_login,
    parse_device_info,
    build_login_ack,
    build_device_info_ack,
    build_time_sync_ack,
    build_time_sync_ack_bcd,
    build_frame,
    sn_decode,
)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
LISTEN_PORT = int(os.environ.get("GLK_BRIDGE_PORT", "8766"))
LOCAL_BACKEND_URL = os.environ.get(
    "GLK_BACKEND_URL",
    "http://localhost:4000"
)
# Ensure URL ends with the vitals endpoint
if not LOCAL_BACKEND_URL.endswith("/api/glk/vitals"):
    LOCAL_BACKEND_URL = LOCAL_BACKEND_URL.rstrip("/") + "/api/glk/vitals"

# Optional: also forward to remote cloud backend
REMOTE_BACKEND_URL = os.environ.get("REMOTE_BACKEND_URL", "")
# The remote backend accepts vitals at /api/health (emfit_logs_route)
if REMOTE_BACKEND_URL and not REMOTE_BACKEND_URL.endswith("/api/health"):
    REMOTE_BACKEND_URL = REMOTE_BACKEND_URL.rstrip("/") + "/api/health"

BACKEND_URL = LOCAL_BACKEND_URL  # Primary target is always local Pi server

SECRET_KEY = os.environ.get("HUB_SECRET_KEY", "jwt_secret_of_awesomliving_app")

# How often to forward vitals (seconds). 1 Hz from the device, but we may
# want to throttle to reduce backend load. 0 = forward every frame.
FORWARD_INTERVAL = float(os.environ.get("GLK_FORWARD_INTERVAL", "5"))

# Idle timeout — close connections that send nothing for this long
IDLE_TIMEOUT = float(os.environ.get("GLK_IDLE_TIMEOUT", "600"))

# Debug knobs
TIME_FORMAT = os.environ.get("GLK_TIME_FORMAT", "epoch").lower()      # epoch (default/fix) | bcd (broken, debug only)
SKIP_TIME_ACK = os.environ.get("GLK_SKIP_TIME_ACK", "0") == "1"
LOG_LEVEL = os.environ.get("GLK_LOG_LEVEL", "INFO").upper()

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s [glk-bridge] %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("glk-bridge")


# ---------------------------------------------------------------------------
# Command name helper (for readable logs)
# ---------------------------------------------------------------------------
CMD_NAMES = {
    CMD_LOGIN: "LOGIN",
    CMD_TIME_SYNC: "TIME_SYNC",
    CMD_DEVICE_INFO: "DEVICE_INFO",
    CMD_REALTIME: "REALTIME",
    CMD_SLEEP_STAGE: "SLEEP_STAGE",
    CMD_EMERGENCY: "EMERGENCY",
}


def cmd_name(cmd: int) -> str:
    return CMD_NAMES.get(cmd, f"0x{cmd:02X}")


# ---------------------------------------------------------------------------
# Time Sync ACK — default is now 4-byte epoch (the fix for the loop)
# ---------------------------------------------------------------------------
# ROOT CAUSE: device sends 4-byte payload, old bridge responded with 6-byte
# BCD. Length mismatch caused the device to reject every ACK, retry 7x, and
# disconnect. The fix: respond with a 4-byte big-endian Unix epoch.
#
# GLK_TIME_FORMAT env var kept for debugging only:
#   epoch (DEFAULT) — 4-byte big-endian Unix timestamp (THE FIX)
#   bcd             — 6-byte packed-BCD (BROKEN, causes loop — debug only)

def get_time_sync_ack(seq: int) -> bytes:
    """Build Time Sync ACK using the configured format."""
    if TIME_FORMAT == "bcd":
        ack = build_time_sync_ack_bcd(seq)
        log.warning("  Time Sync ACK (BCD/6-byte — DEBUG ONLY, causes loop): %s", ack.hex())
        return ack
    else:  # default: epoch (4 bytes) — THE FIX
        ack = build_time_sync_ack(seq)
        log.info("  Time Sync ACK (epoch/4-byte): %s", ack.hex())
        return ack


# ---------------------------------------------------------------------------
# Realtime (0x0E) decode — VERIFIED offsets, do NOT re-derive from PDF
# ---------------------------------------------------------------------------
STATUS_MAP = {
    0: "initializing",
    1: "in_bed",
    2: "apnea_suspected",
    3: "snoring",
    4: "out_of_bed",
    5: "life_abnormality",
    6: "light_sleep",
}

# Statuses that mean the person is physically on the pad
IN_BED_STATUSES = {1, 2, 3, 5, 6}


# ---------------------------------------------------------------------------
# Sleep stage (0x4E) mappings — Protocol V1.0.2.3 Section 6
# ---------------------------------------------------------------------------
SLEEP_STAGE_MAP = {
    0: "invalid",
    1: "awake",
    2: "light_sleep",
    4: "deep_sleep",
    5: "rem",
}

SLEEP_STATUS_MAP = {
    1: "life_abnormality",
    2: "sleep_apnea",
    3: "in_bed",
    4: "out_of_bed",
    5: "snoring",
    6: "body_movement",
}

# 0x4E statuses that mean the person is in bed (everything except out_of_bed)
SLEEP_IN_BED_STATUSES = {1, 2, 3, 5, 6}


def parse_realtime(frame: dict) -> dict:
    """Decode 0x0E realtime vitals.

    Corrected byte layout (Aug 2026, verified against production data):
        p[0:2]  = protocol markers (constant 0x6A, 0x8A) — NOT vitals
        p[2:4]  = 16-bit BE second counter — NOT status/movement
        p[4]    = heart rate (bpm, 0 = no contact / out of bed)
        p[5]    = respiration rate (brpm, 0 = no contact / apnea)
        p[6]    = status code (0-6 per STATUS_MAP)
        p[7]    = battery level (percentage, often 100)
        p[8]    = reserved (usually 0)
        p[9]    = signal quality (usually 100)
        p[10]   = body movement intensity (0-255)

    v20: All 13 raw device fields now returned (added signal_quality).

    Evidence that the OLD offsets (p[0]=HR, p[1]=RR) were wrong:
        - "heart_rate" was ALWAYS 106 (0x6A) across 317 readings — constant
        - "respiration_rate" was ALWAYS 138 (0x8A) — constant
        - Byte 4 ranged 53-84 (avg 68.5) — matches resting heart rate
        - Byte 5 ranged 11-26 (avg 15.2) — matches normal respiration rate
        - When byte 6 = 4 (out_of_bed), bytes 4 and 5 were ALWAYS 0
    """
    p = frame["payload"]
    if len(p) < 11:
        return {}

    sc = p[6]
    return {
        "heart_rate": p[4] if p[4] != 0xFF else None,
        "respiration_rate": p[5] if p[5] != 0xFF else None,
        "status_code": sc,
        "status": STATUS_MAP.get(sc, f"unknown_{sc}"),
        "in_bed": sc in IN_BED_STATUSES,
        "out_of_bed": sc == 4,
        "apnea_suspected": sc == 2,
        "snoring": sc == 3,
        "body_movement": p[10] if len(p) > 10 else 0,
        "battery_level": p[7] if len(p) > 7 else None,
        "signal_quality": p[9] if len(p) > 9 else None,
        "life_abnormality": sc == 5,
        "timer_counter": (p[2] << 8) | p[3],
    }


def parse_sleep_stage(frame: dict) -> dict:
    """Parse 0x4E sleep stage payload.

    Payload layout (Protocol V1.0.2.3 Section 6, verified against firmware v0570):
      payload[0:4]  — time_offset (4 bytes, big-endian Unix timestamp)
      payload[4]    — heart_rate (bpm, 0xFF = unavailable)
      payload[5]    — breathing_rate (/min, 0xFF = unavailable)
      payload[6]    — status (1=life_abnormality, 2=sleep_apnea, 3=in_bed,
                              4=out_of_bed, 5=snoring, 6=body_movement)
      payload[7]    — battery (0-100%)
      payload[8]    — sleep_stage (0=invalid, 1=awake, 2=light, 4=deep, 5=rem)
      payload[9:15] — serial_number (6 bytes, optional in some firmware)
      payload[15:19]— secondary timestamp (4 bytes, optional)
    """
    p = frame["payload"]
    if len(p) < 9:
        log.warning("  0x4E payload too short (%d bytes), need at least 9", len(p))
        return {"type": "sleep_stage", "raw_hex": frame["raw"].hex()}

    time_offset = struct.unpack(">I", p[0:4])[0]
    hr = p[4]
    rr = p[5]
    sc = p[6]
    battery = p[7]
    stage = p[8]

    # extract embedded serial if present (bytes 9-14)
    embedded_sn = None
    if len(p) >= 15:
        embedded_sn = sn_decode(p[9:15])

    return {
        "type": "sleep_stage",
        "heart_rate": hr if hr != 0xFF else None,
        "respiration_rate": rr if rr != 0xFF else None,
        "status_code": sc,
        "status": SLEEP_STATUS_MAP.get(sc, f"unknown_{sc}"),
        "in_bed": sc in SLEEP_IN_BED_STATUSES,
        "out_of_bed": sc == 4,
        "life_abnormality": sc == 1,
        "apnea_suspected": sc == 2,
        "snoring": sc == 5,
        "body_movement": sc == 6,
        "battery_level": battery,
        "sleep_stage_code": stage,
        "sleep_stage": SLEEP_STAGE_MAP.get(stage, f"unknown_{stage}"),
        "time_offset": time_offset,
        "embedded_serial": embedded_sn,
        "raw_hex": frame["raw"].hex(),
    }


def build_sleep_stage_ack(seq: int) -> bytes:
    """Build 0x4E ACK: 82 05 00 <seq> 4E 01 <xor>.
    Required by protocol — without this ACK the device disconnects."""
    return build_frame(seq, CMD_SLEEP_STAGE, payload=b"\x01", ack=0x00)


# ---------------------------------------------------------------------------
# Backend forwarding
# ---------------------------------------------------------------------------
def forward_to_backend(sn: str, data: dict) -> bool:
    """POST vitals to the local Pi server (and optionally to the remote cloud backend)."""
    payload = json.dumps({
        "serial_number": sn,
        "secret_key": SECRET_KEY,
        "data": data,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }).encode("utf-8")

    ok = False

    # Primary: POST to local Pi server.js
    req = Request(
        LOCAL_BACKEND_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(req, timeout=5) as resp:
            ok = 200 <= resp.status < 300
    except (URLError, OSError) as e:
        log.warning("Local backend POST failed: %s", e)

    # Secondary: also forward to remote cloud backend (non-blocking, best-effort)
    if REMOTE_BACKEND_URL:
        req2 = Request(
            REMOTE_BACKEND_URL,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urlopen(req2, timeout=10) as resp:
                pass  # best-effort, don't block on result
        except (URLError, OSError):
            pass  # silently ignore remote failures

    return ok


# ---------------------------------------------------------------------------
# Per-connection handler
# ---------------------------------------------------------------------------
async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    peer = writer.get_extra_info("peername")
    log.info("Connection from %s", peer)

    # Enable TCP_NODELAY to prevent Nagle from buffering our small ACK frames
    sock = writer.get_extra_info("socket")
    if sock:
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        log.info("  TCP_NODELAY enabled")

    sn = "UNKNOWN"
    last_forward = 0.0
    time_sync_count = 0    # track how many Time Syncs this connection
    sleep_stage_count = 0  # track how many 0x4E frames this connection
    realtime_count = 0     # track how many 0x0E frames this connection
    connect_time = time.time()  # epoch when TCP connected
    device_firmware = None
    device_type = None
    device_verification_code = None
    peer_ip = peer[0] if peer else "unknown"
    disconnect_reason = "unknown"
    buf = bytearray()

    try:
        while True:
            try:
                data = await asyncio.wait_for(reader.read(4096), timeout=IDLE_TIMEOUT)
            except asyncio.TimeoutError:
                log.info("sn=%s idle timeout, closing", sn)
                break
            if not data:
                break  # client disconnected

            # ── RAW HEX DUMP of every TCP read ──
            log.info("sn=%s ◀ RECV %d bytes: %s", sn, len(data), data.hex())

            buf.extend(data)

            # Process all complete frames in the buffer
            while len(buf) >= 6:
                # Skip non-0x82 bytes (undocumented keepalives)
                if buf[0] != FRAME_START:
                    # Scan forward for next 0x82
                    idx = buf.find(bytes([FRAME_START]), 1)
                    if idx == -1:
                        skipped = bytes(buf)
                        buf.clear()
                        log.info("sn=%s  !! skipped %d non-frame bytes: %s",
                                 sn, len(skipped), skipped.hex())
                        break
                    else:
                        log.info("sn=%s  !! skipped %d non-frame bytes: %s",
                                 sn, idx, bytes(buf[:idx]).hex())
                        del buf[:idx]
                        continue

                # Check if we have enough bytes
                if len(buf) < 2:
                    break
                frame_len = buf[1]
                total = 2 + frame_len
                if len(buf) < total:
                    break  # wait for more data

                raw = bytes(buf[:total])
                del buf[:total]

                frame = parse_frame(raw)
                if frame is None:
                    log.warning("sn=%s ✗ BAD FRAME (checksum?): %s", sn, raw.hex())
                    continue

                cmd = frame["cmd"]
                seq = frame["seq"]
                payload = frame["payload"]

                log.info("sn=%s ◀ FRAME cmd=%s seq=0x%02X ack=0x%02X payload(%dB)=%s",
                         sn, cmd_name(cmd), seq, frame["ack"], len(payload),
                         payload.hex() if payload else "(empty)")

                # ── Login (0x03) ──
                if cmd == CMD_LOGIN:
                    info = parse_login(frame)
                    sn = info.get("sn", "UNKNOWN")
                    time_sync_count = 0
                    sleep_stage_count = 0
                    realtime_count = 0
                    connect_time = time.time()
                    log.info("  Login from sn=%s", sn)
                    ack = build_login_ack(seq)
                    log.info("sn=%s ▶ SEND LOGIN_ACK: %s", sn, ack.hex())
                    writer.write(ack)
                    await writer.drain()

                # ── Device Info (0x04) ──
                elif cmd == CMD_DEVICE_INFO:
                    info = parse_device_info(frame)
                    dev_sn = info.get("sn", sn)
                    fw = info.get("firmware", "?")
                    device_firmware = fw
                    device_type = info.get("device_type", "unknown")
                    device_verification_code = info.get("verification_code", None)
                    log.info("  Device info sn=%s firmware=%s type=%s vcode=%s",
                             dev_sn, fw, device_type, device_verification_code)
                    if dev_sn != "UNKNOWN":
                        sn = dev_sn
                    ack = build_device_info_ack(seq)
                    log.info("sn=%s ▶ SEND DEVICE_INFO_ACK: %s", sn, ack.hex())
                    writer.write(ack)
                    await writer.drain()
                    # v24: forward device info + connected event to backend
                    connected_data = {
                        "type": "device_status",
                        "event": "connected",
                        "firmware": device_firmware,
                        "device_type": device_type,
                        "verification_code": device_verification_code,
                        "ip_address": peer_ip,
                        "connection_time": datetime.fromtimestamp(
                            connect_time, tz=timezone.utc
                        ).isoformat(),
                    }
                    log.info("  DEVICE_CONNECTED sn=%s firmware=%s type=%s ip=%s",
                             sn, device_firmware, device_type, peer_ip)
                    asyncio.get_event_loop().run_in_executor(
                        None, forward_to_backend, sn, connected_data
                    )

                # ── Time Sync (0x02) ──
                elif cmd == CMD_TIME_SYNC:
                    time_sync_count += 1
                    log.info("  Time sync request #%d (payload=%s)",
                             time_sync_count, payload.hex() if payload else "(empty)")

                    if SKIP_TIME_ACK:
                        log.info("  GLK_SKIP_TIME_ACK=1 — NOT sending Time Sync ACK")
                    else:
                        ack = get_time_sync_ack(seq)
                        log.info("sn=%s ▶ SEND TIME_SYNC_ACK (#%d): %s",
                                 sn, time_sync_count, ack.hex())
                        writer.write(ack)
                        await writer.drain()

                # ── Realtime Vitals (0x0E) ──
                elif cmd == CMD_REALTIME:
                    realtime_count += 1
                    vitals = parse_realtime(frame)
                    if vitals:
                        now = time.monotonic()
                        if now - last_forward >= FORWARD_INTERVAL:
                            last_forward = now
                            hr = vitals.get("heart_rate")
                            rr = vitals.get("respiration_rate")
                            st = vitals.get("status", "?")
                            bat = vitals.get("battery_level", "?")
                            sig = vitals.get("signal_quality", "?")
                            log.info("  VITALS sn=%s HR=%s RR=%s status=%s battery=%s signal=%s",
                                     sn, hr, rr, st, bat, sig)
                            # Forward in background to avoid blocking the frame loop
                            asyncio.get_event_loop().run_in_executor(
                                None, forward_to_backend, sn, vitals
                            )

                # ── Sleep Stage (0x4E) ──
                elif cmd == CMD_SLEEP_STAGE:
                    sleep_stage_count += 1
                    stage_data = parse_sleep_stage(frame)
                    log.info("  SLEEP_STAGE #%d sn=%s HR=%s RR=%s stage=%s status=%s battery=%s",
                             sleep_stage_count, sn,
                             stage_data.get("heart_rate"),
                             stage_data.get("respiration_rate"),
                             stage_data.get("sleep_stage"),
                             stage_data.get("status"),
                             stage_data.get("battery_level"))
                    # send ACK — required by protocol or device disconnects
                    ack = build_sleep_stage_ack(seq)
                    log.info("sn=%s ▶ SEND SLEEP_STAGE_ACK: %s", sn, ack.hex())
                    writer.write(ack)
                    await writer.drain()
                    # forward parsed data to backend
                    asyncio.get_event_loop().run_in_executor(
                        None, forward_to_backend, sn, stage_data
                    )

                # ── Emergency (0x0D) ──
                elif cmd == CMD_EMERGENCY:
                    log.warning("  EMERGENCY frame from sn=%s!", sn)
                    # v24: parse actual payload instead of hardcoding nulls
                    ep = frame["payload"]
                    emergency_data = {
                        "type": "emergency",
                        "life_abnormality": True,
                        "status_code": 5,
                        "status": "life_abnormality",
                        "in_bed": True,
                        "out_of_bed": False,
                        "heart_rate": ep[1] if len(ep) > 1 and ep[1] != 0xFF else None,
                        "respiration_rate": ep[2] if len(ep) > 2 and ep[2] != 0xFF else None,
                        "emergency_flag": ep[0] if len(ep) > 0 else 1,
                        "battery_level": ep[3] if len(ep) > 3 else None,
                        "payload_length": len(ep),
                        "raw_hex": raw.hex(),
                    }
                    log.warning("  EMERGENCY sn=%s HR=%s RR=%s flag=%s battery=%s",
                                sn, emergency_data["heart_rate"],
                                emergency_data["respiration_rate"],
                                emergency_data["emergency_flag"],
                                emergency_data["battery_level"])
                    asyncio.get_event_loop().run_in_executor(
                        None, forward_to_backend, sn, emergency_data
                    )

                else:
                    log.info("  UNKNOWN cmd=0x%02X (%d payload bytes): %s",
                             cmd, len(payload), payload.hex())

    except (ConnectionResetError, BrokenPipeError) as exc:
        disconnect_reason = "connection_reset"
        log.info("sn=%s connection reset (time_syncs=%d, sleep_stages=%d)",
                 sn, time_sync_count, sleep_stage_count)
    except asyncio.TimeoutError:
        disconnect_reason = "idle_timeout"
    except Exception:
        disconnect_reason = "unexpected_error"
        log.exception("sn=%s unexpected error", sn)
    else:
        disconnect_reason = "clean_close"
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
        # v24: forward disconnect event with session stats to backend
        session_duration = int(time.time() - connect_time)
        log.info("sn=%s disconnected (time_syncs=%d, sleep_stages=%d, "
                 "realtime=%d, duration=%ds, reason=%s)",
                 sn, time_sync_count, sleep_stage_count,
                 realtime_count, session_duration, disconnect_reason)
        if sn != "UNKNOWN":
            disconnected_data = {
                "type": "device_status",
                "event": "disconnected",
                "firmware": device_firmware,
                "device_type": device_type,
                "ip_address": peer_ip,
                "session_duration_seconds": session_duration,
                "time_syncs_this_session": time_sync_count,
                "sleep_stages_this_session": sleep_stage_count,
                "realtime_frames_this_session": realtime_count,
                "disconnect_reason": disconnect_reason,
                "connection_time": datetime.fromtimestamp(
                    connect_time, tz=timezone.utc
                ).isoformat(),
                "disconnect_time": datetime.now(timezone.utc).isoformat(),
            }
            try:
                forward_to_backend(sn, disconnected_data)
            except Exception:
                log.warning("sn=%s failed to forward disconnect event", sn)


# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------
async def run_server():
    server = await asyncio.start_server(handle_client, "0.0.0.0", LISTEN_PORT)
    addrs = ", ".join(str(s.getsockname()) for s in server.sockets)
    log.info("GLK bridge listening on %s", addrs)
    log.info("  Time format: %s  |  Skip time ACK: %s", TIME_FORMAT, SKIP_TIME_ACK)

    # Graceful shutdown on SIGTERM/SIGINT
    loop = asyncio.get_event_loop()
    stop = asyncio.Event()

    def _stop():
        log.info("Shutdown signal received")
        stop.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, _stop)

    async with server:
        await stop.wait()
    log.info("GLK bridge stopped")


def main():
    log.info("Starting GLK bridge v24 (port=%d, local_backend=%s, remote_backend=%s, forward_interval=%.0fs)",
             LISTEN_PORT, LOCAL_BACKEND_URL, REMOTE_BACKEND_URL or "(none)", FORWARD_INTERVAL)
    log.info("  Time format=%s, skip_time_ack=%s", TIME_FORMAT, SKIP_TIME_ACK)
    asyncio.run(run_server())


if __name__ == "__main__":
    main()
