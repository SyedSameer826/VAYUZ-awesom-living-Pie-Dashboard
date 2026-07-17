# GLK Sleep Monitor — Pie Pairing

This folder holds the BLE provisioning used by the Pie platform's **Pair GLK** flow.

## Files
- `glk_protocol.py` — verified GLK frame + BLE packet builders (from the GLK team).
  Run `python3 glk_protocol.py --selftest` → expect **ALL CHECKS PASSED**.
- `glk_provision.py` — CLI the Pie backend shells out to:
  - `python3 glk_provision.py scan` → lists `LZ-OTA…` devices (JSON).
  - `python3 glk_provision.py provision --address … --ssid … --password … --pi-ip … --port 8766`
    → writes WiFi (`0x1F`) + server (`0x23`) config over BLE (JSON result).
- `requirements.txt` — `bleak` (BLE library).

## How pairing works (Pie platform)
1. **Pair GLK** button → `POST /api/glk/scan` → BLE scan → device list.
2. Pick a device, enter the home **2.4 GHz** WiFi SSID/password + resident →
   `POST /api/glk/pair`.
3. The backend auto-detects the Pi's LAN IP (`192.168.50.x`), provisions the device
   (WiFi + `"<Pi IP>","8766"`), records it locally, and maps it to the resident on
   the cloud backend as an **Emfit**-type device (`sr_num` = the 12-digit serial).

## One-time setup on the Pi
```bash
pip install -r requirements.txt        # installs bleak (needs BlueZ)
python3 glk_protocol.py --selftest      # sanity check the frame logic
```
The Node backend runs the provisioner as the `pi` user, which must be allowed to
use Bluetooth (BlueZ/D-Bus). To point at the GLK team's own script instead, set
`GLK_PROVISION_CMD` to its path (same `scan`/`provision` CLI + JSON output).

## ⚠️ Required for data to actually flow: the TCP bridge
Pairing only tells the device *where* to connect. It then streams sleep data over
**raw TCP to this Pi on port 8766** — which needs **`glk_bridge.py` running and
listening on :8766**, forwarding frames to the backend ingestion route. That bridge
is **not part of this pairing flow** and (per current status) is **not yet set up**.

Until the bridge runs, a paired device will connect, fail to hand-shake, and retry
(~60 s loop). Build/deploy `glk_bridge.py` next (it needs the verified `0x0E`
realtime decoder from the GLK team's tested bridge — that one piece is intentionally
not re-derived here).
