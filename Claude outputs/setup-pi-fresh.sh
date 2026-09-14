#!/usr/bin/env bash
# ============================================================================
# setup-pi-fresh.sh — Complete Raspberry Pi Setup for Awesom Living
# ============================================================================
# Brings a fresh Pi (Raspberry Pi OS, SSH enabled) to full production state.
#
# What this installs:
#   1. camera-wrapper   — Express proxy for go2rtc REST API (port 3002)
#   2. go2rtc           — RTSP → WebRTC/HLS transcoder (port 1984)
#   3. Mosquitto        — MQTT broker (port 1883)
#   4. Zigbee2MQTT      — Zigbee coordinator (port 8080 UI)
#   5. MQTT bridge      — Forwards Zigbee events to cloud backend
#   6. GLK bridge       — TCP listener for GLK Sleep Monitor (port 8766)
#   7. Hub heartbeat    — Reports hub online/offline status to cloud backend
#   8. autossh tunnel   — Reverse SSH tunnel for camera to EC2 (port 1984)
#   9. Pi Dashboard     — Local dashboard + API server (port 4000)
#
# Network: 192.168.50.x subnet (pilot home)
# EC2:     13.127.250.78 (Mumbai) / awesomliving.com
# Cameras: Multiple CP Plus cameras (see CAMERAS array below)
#
# Usage:
#   chmod +x setup-pi-fresh.sh
#   ./setup-pi-fresh.sh
#
# Updated: 2026-09-08 v5 — SNAKE_CASE CONVENTION:
#   All embedded JavaScript (camera-wrapper, mqtt-bridge, repo patches)
#   converted from camelCase to snake_case per project convention.
#   Added sed patch to rename discoverCameras import in repo files.
#   No logic changes — only identifier renames.
#
# Updated: 2026-09-03 v4 — REMOTE SHUTDOWN/REBOOT + SAFE POWER-OFF:
#   Remote shutdown/reboot from the mobile app:
#     - App POSTs to cloud backend /api/hub/command with {home_id, command}
#     - Cloud stores command in hub_status.pending_command (MongoDB)
#     - Pi's heartbeat response carries pending_command field
#     - server.js executes "sudo shutdown -h now" or "sudo reboot" on receipt
#     - Commands expire after 5 min (stale-command guard)
#   Sudoers for shutdown/reboot:
#     - NOPASSWD added for /sbin/shutdown and /sbin/reboot
#     - PM2 runs server.js as user pi — without NOPASSWD, sudo silently fails
#     - This is the same pattern used for arp-scan/nmap in v2
#   Why this matters:
#     - Moving the Pi without shutting down first corrupts the SD card
#     - This lets the family safely shut down the Pi from the app before moving it
#     - After moving, plugging in power restarts the Pi automatically
#
# Updated: 2026-08-14 v3 — MULTI-CAMERA + BULK HEARTBEAT:
#   Multi-camera support:
#     - CAMERAS array replaces single CAMERA_IP / CAMERA_STREAM_NAME
#     - Each entry: STREAM_NAME|IP|USER|PASS (pipe-delimited)
#     - go2rtc.yaml generated with ALL camera streams
#     - Backward compatible: single-entry CAMERAS array works identically to v2
#   Bulk heartbeat:
#     - camera-wrapper reads CAMERA_CONFIG env var (all cameras, pipe-delimited)
#     - TCP probes ALL cameras in parallel
#     - Calls /api/camera/bulk-heartbeat with array of {stream_name, camera_last_seen}
#     - /health endpoint reports status of ALL cameras
#   Cloudflare tunnel:
#     - Production note: p1.awesomliving.com named tunnel replaces autossh
#
# Updated: 2026-08-11 v2 — DEVICE SYNC + CAMERA SCAN + SUDOERS FIXES:
#   Device listing fix (devices.json empty / 0 devices):
#     - mqttClient.js patched to add bridge/devices handler that calls
#       upsertDevice() for each Z2M device → populates devices.json
#     - GitHub repo version was MISSING this entire handler
#   Camera scan fix ("No cameras found" from Pi Dashboard):
#     - cameraDiscovery.js patched: auto-detect interface (was hardcoded eth0),
#       nmap fallback, expanded OUI list for CP Plus/Dahua cameras
#     - Sudoers NOPASSWD added for arp-scan + nmap (PM2 runs as user pi
#       without a TTY — sudo silently fails without NOPASSWD)
#     - nmap added to apt-get install list
#   deviceStore.js REMOTE_BACKEND URL fixed to https://awesomliving.com
#
# Updated: 2026-08-11 — CAMERA FIX + PM2 BOOT PERSISTENCE:
#   Camera fixes:
#     - CAMERA_STREAM_NAME fixed to "cam_50_102" (matches MongoDB)
#     - Camera IP at 192.168.50.100 (was .102, DHCP moved it)
#     - go2rtc.yaml has stream HARDCODED in config file (not added at
#       runtime via API, which loses the stream on wrapper restart)
#     - camera-wrapper default stream name fixed to cam_50_102
#   PM2 boot persistence (Pi was dead after 12hr power-off):
#     - pm2 startup systemd now runs UNCONDITIONALLY (was only on
#       first install inside "if ! command -v pm2" block)
#     - Evals the sudo command pm2 startup prints (required step)
#     - Falls back to manual systemd service creation if pm2 startup fails
#     - @reboot cron added as belt-and-suspenders backup
#     - pm2 save runs AFTER all processes are registered
#     - All systemd services verified enabled at end of script
#
# Previous: 2026-08-10 — Pi Dashboard Git repo clone, React 19 + Vite 8,
#           Express 5 ESM, Hub heartbeat, GLK fixes, camera TCP probe.
# ============================================================================

set -e

# ── Configuration (edit these for a different deployment) ──────────────────

# Camera configuration — one line per camera: STREAM_NAME|IP|USER|PASS
# Add or remove entries as cameras are added to the home.
# If only one camera, this works identically to v2 (single-camera mode).
CAMERAS=(
  "cam_50_102|192.168.50.102|admin|Test@1234"
  "cam_50_103|192.168.50.103|admin|Test@1234"
)

EC2_IP="13.127.250.78"
EC2_USER="ubuntu"
EC2_DOMAIN="awesomliving.com"
EC2_BACKEND="https://${EC2_DOMAIN}"

BACKEND_API_URL="${EC2_BACKEND}/api/device-event"
ZIGBEE_SECRET="jwt_secret_of_awesomliving_app"
HUB_SECRET="jwt_secret_of_awesomliving_app"

PI_USER="pi"
PI_HOME="/home/${PI_USER}"
REPO_DIR="${PI_HOME}/VAYUZ-awesom-living-Pie-Dashboard"

# ── Parse CAMERAS array into usable variables ─────────────────────────────
# Build a single pipe-delimited string for passing to camera-wrapper env var.
# Format: "name1|ip1|user1|pass1;;name2|ip2|user2|pass2"
CAMERA_CONFIG=""
FIRST_CAMERA_IP=""
FIRST_CAMERA_STREAM=""
for entry in "${CAMERAS[@]}"; do
  IFS='|' read -r _name _ip _user _pass <<< "$entry"
  if [ -z "$FIRST_CAMERA_IP" ]; then
    FIRST_CAMERA_IP="$_ip"
    FIRST_CAMERA_STREAM="$_name"
  fi
  if [ -n "$CAMERA_CONFIG" ]; then
    CAMERA_CONFIG="${CAMERA_CONFIG};;${entry}"
  else
    CAMERA_CONFIG="${entry}"
  fi
done

# ── Pre-flight checks ─────────────────────────────────────────────────────
PI_IP=$(hostname -I | awk '{print $1}')
echo "============================================"
echo "  Awesom Living — Fresh Pi Setup (v5)"
echo "  Pi IP:     ${PI_IP}"
echo "  Cameras:   ${#CAMERAS[@]} configured"
for entry in "${CAMERAS[@]}"; do
  IFS='|' read -r _name _ip _user _pass <<< "$entry"
  echo "    - ${_name} @ ${_ip}"
done
echo "  EC2:       ${EC2_IP}"
echo "  Backend:   ${EC2_BACKEND}"
echo "============================================"
echo ""

# Keep sudo alive throughout the script
echo "1234" | sudo -S -v 2>/dev/null || sudo -v
( while true; do sudo -n -v 2>/dev/null; sleep 60; done ) &
SUDO_KEEPALIVE_PID=$!
trap 'kill $SUDO_KEEPALIVE_PID 2>/dev/null' EXIT

# Bump swap for heavy installs (zigbee2mqtt build)
if [ -f /etc/dphys-swapfile ]; then
    sudo sed -i 's/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=1024/' /etc/dphys-swapfile
    sudo systemctl restart dphys-swapfile
fi

# ── System dependencies ───────────────────────────────────────────────────
echo "[0/9] Installing system dependencies..."

# Kill packagekitd — it grabs the apt lock on fresh Raspberry Pi OS and
# causes "Could not get lock /var/lib/apt/lists/lock" errors.
sudo systemctl stop packagekit 2>/dev/null || true
sudo systemctl disable packagekit 2>/dev/null || true
sudo killall packagekitd 2>/dev/null || true

# Wait for any remaining apt lock to be released (up to 60s)
APT_WAIT=0
while sudo fuser /var/lib/apt/lists/lock /var/lib/dpkg/lock /var/lib/dpkg/lock-frontend 2>/dev/null; do
    if [ $APT_WAIT -ge 60 ]; then
        echo "  WARNING: apt lock still held after 60s — forcing..."
        sudo rm -f /var/lib/apt/lists/lock /var/lib/dpkg/lock /var/lib/dpkg/lock-frontend
        break
    fi
    echo "  Waiting for apt lock to be released... (${APT_WAIT}s)"
    sleep 5
    APT_WAIT=$((APT_WAIT + 5))
done

sudo apt-get update -qq
sudo apt-get install -y \
    git curl autossh mosquitto mosquitto-clients \
    python3-pip python3-dev libglib2.0-dev bluetooth bluez \
    jq arp-scan nmap

# Node.js 20 (required by Vite 8 / React 19 frontend build)
if ! command -v node &>/dev/null || [[ $(node -v | cut -d. -f1 | tr -d v) -lt 20 ]]; then
    echo "  Installing Node.js 20 (required by Vite 8)..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# pm2 global
if ! command -v pm2 &>/dev/null; then
    sudo npm install -g pm2
fi

echo "  Node $(node -v), npm $(npm -v), pm2 $(pm2 -v 2>/dev/null || echo 'installed')"

# ── Sudoers: let the pi user run arp-scan and nmap without a password ──
# Camera discovery (cameraDiscovery.js) needs sudo arp-scan/nmap, but PM2
# runs as user pi without a TTY, so sudo silently fails without NOPASSWD.
sudo tee /etc/sudoers.d/pi-awesomliving > /dev/null << 'SUDOEOF'
pi ALL=(ALL) NOPASSWD: /usr/sbin/arp-scan
pi ALL=(ALL) NOPASSWD: /usr/bin/nmap
pi ALL=(ALL) NOPASSWD: /sbin/shutdown
pi ALL=(ALL) NOPASSWD: /sbin/reboot
SUDOEOF
sudo chmod 0440 /etc/sudoers.d/pi-awesomliving
echo "  Sudoers: arp-scan + nmap + shutdown + reboot NOPASSWD for ${PI_USER}"


# ================================================================
# 1. CAMERA-WRAPPER (Express proxy for go2rtc API — multi-camera)
# ================================================================
echo ""
echo "[1/9] Setting up camera-wrapper (multi-camera)..."

WRAPPER_DIR="${PI_HOME}/camera-wrapper"
mkdir -p "$WRAPPER_DIR"

cat > "$WRAPPER_DIR/package.json" << 'EOF'
{
  "name": "camera-wrapper",
  "version": "2.0.0",
  "type": "module",
  "main": "go2rtc.service.js",
  "dependencies": {
    "express": "^4.18.2",
    "cors": "^2.8.5"
  }
}
EOF

cat > "$WRAPPER_DIR/go2rtc.service.js" << 'SVCEOF'
// Camera Wrapper — Awesom Living v3 (Multi-Camera + Bulk Heartbeat)
//
// Reads CAMERA_CONFIG env var: pipe-delimited camera entries separated by ";;".
// Each entry: STREAM_NAME|IP|USER|PASS
// Example: "cam_50_102|192.168.50.102|admin|Test@1234;;cam_50_103|192.168.50.103|admin|Test@1234"
//
// For each camera: TCP probe RTSP port 554 to detect power on/off.
// Calls /api/camera/bulk-heartbeat with array of { stream_name, camera_last_seen }.
// /health reports status of ALL cameras.
import express from "express";
import cors from "cors";
import net from "net";

const app = express();
app.use(cors());
app.use(express.json());

const GO2RTC_API = process.env.GO2RTC_URL || "http://localhost:1984";
const BACKEND_URL = process.env.BACKEND_URL || "https://awesomliving.com";
const HUB_SECRET = process.env.HUB_SECRET || "jwt_secret_of_awesomliving_app";
const HEARTBEAT_INTERVAL = 30_000;

// ── Parse CAMERA_CONFIG into camera objects ──
// Format: "name|ip|user|pass;;name|ip|user|pass"
// Falls back to legacy single-camera env vars for backward compat.
function parse_camera_config() {
  const config_str = process.env.CAMERA_CONFIG || "";
  if (config_str) {
    const entries = config_str.split(";;").filter(Boolean);
    return entries.map(entry => {
      const [stream_name, ip, user, pass] = entry.split("|");
      return { stream_name, ip, user, pass };
    });
  }
  // Legacy fallback: single camera from old env vars
  const stream = process.env.CAMERA_STREAM_NAME || "cam_50_102";
  const ip = process.env.CAMERA_IP || "192.168.50.100";
  return [{ stream_name: stream, ip, user: "admin", pass: "Test@1234" }];
}

const cameras = parse_camera_config();
console.log(`\x1b[32m[camera-wrapper] ${cameras.length} camera(s) configured:\x1b[0m`);
for (const cam of cameras) {
  console.log(`\x1b[32m  - ${cam.stream_name} @ ${cam.ip}\x1b[0m`);
}

// TCP probe — most reliable camera power-on/off detection (no caching)
function tcp_probe(host, port, timeout_ms) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeout_ms);
    socket.on("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.on("error",   () => { clearTimeout(timer); socket.destroy(); resolve(false); });
    socket.connect(port, host);
  });
}

// Check a single camera's liveness via TCP probe + frame grab fallback
async function is_camera_alive(cam) {
  // Method 1: TCP probe to RTSP port 554
  try {
    if (await tcp_probe(cam.ip, 554, 5000)) {
      console.log(`\x1b[32m[heartbeat] ${cam.stream_name} alive (TCP ${cam.ip}:554 open)\x1b[0m`);
      return true;
    }
    console.log(`\x1b[33m[heartbeat] ${cam.stream_name} TCP probe failed (${cam.ip}:554 not reachable)\x1b[0m`);
  } catch (e) {
    console.log(`\x1b[33m[heartbeat] ${cam.stream_name} TCP probe error: ${e.message}\x1b[0m`);
  }

  // Method 2: Frame grab from go2rtc (fallback)
  try {
    const frame_res = await fetch(
      `${GO2RTC_API}/api/frame.jpeg?src=${cam.stream_name}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (frame_res.ok) {
      console.log(`\x1b[32m[heartbeat] ${cam.stream_name} alive (go2rtc frame OK)\x1b[0m`);
      return true;
    }
    console.log(`\x1b[33m[heartbeat] ${cam.stream_name} frame grab failed: status ${frame_res.status}\x1b[0m`);
  } catch (_) {
    console.log(`\x1b[33m[heartbeat] ${cam.stream_name} frame grab timed out\x1b[0m`);
  }
  return false;
}

// Probe all cameras and send bulk heartbeat
async function send_bulk_heartbeat() {
  try {
    // Probe all cameras in parallel
    const results = await Promise.all(
      cameras.map(async (cam) => {
        const alive = await is_camera_alive(cam);
        return { stream_name: cam.stream_name, alive };
      })
    );

    // Only include cameras that are alive
    const alive_cameras = results
      .filter(r => r.alive)
      .map(r => ({
        stream_name: r.stream_name,
        camera_last_seen: new Date().toISOString(),
      }));

    if (alive_cameras.length === 0) {
      console.log(`\x1b[33m[heartbeat] no cameras reachable — skipping bulk heartbeat\x1b[0m`);
      return;
    }

    const res = await fetch(`${BACKEND_URL}/api/camera/bulk-heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-hub-secret": HUB_SECRET },
      body: JSON.stringify({ cameras: alive_cameras }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      console.log(`\x1b[32m[heartbeat] bulk heartbeat OK (${alive_cameras.length}/${cameras.length} cameras alive)\x1b[0m`);
    } else {
      console.warn(`\x1b[33m[heartbeat] bulk heartbeat ${res.status}: ${await res.text()}\x1b[0m`);
    }
  } catch (err) {
    console.warn(`\x1b[33m[heartbeat] bulk heartbeat failed: ${err.message}\x1b[0m`);
  }
}

// Start heartbeat loop
send_bulk_heartbeat();
setInterval(send_bulk_heartbeat, HEARTBEAT_INTERVAL);
console.log(`\x1b[32m[heartbeat] started (every ${HEARTBEAT_INTERVAL / 1000}s to ${BACKEND_URL}, ${cameras.length} camera(s))\x1b[0m`);

// Health endpoint — reports status of ALL cameras
app.get("/health", async (_req, res) => {
  const results = await Promise.all(
    cameras.map(async (cam) => {
      const alive = await is_camera_alive(cam);
      return { stream_name: cam.stream_name, ip: cam.ip, status: alive ? "online" : "offline" };
    })
  );
  const all_online = results.every(r => r.status === "online");
  const any_online = results.some(r => r.status === "online");
  res.json({
    status: all_online ? "ok" : any_online ? "partial" : "all_cameras_offline",
    cameras: results,
    camera_count: cameras.length,
    uptime: process.uptime(),
  });
});

app.get("/streams", async (req, res) => {
  try {
    const response = await fetch(`${GO2RTC_API}/api/streams`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/streams", async (req, res) => {
  try {
    const { name, url } = req.body;
    const response = await fetch(
      `${GO2RTC_API}/api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(url)}`,
      { method: "PUT" }
    );
    res.json({ success: response.ok });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.WRAPPER_PORT || 3002;
app.listen(PORT, () => console.log(`camera-wrapper listening on :${PORT}`));
SVCEOF

cd "$WRAPPER_DIR"
npm install --silent
pm2 delete camera-wrapper 2>/dev/null || true
BACKEND_URL="${EC2_BACKEND}" HUB_SECRET="${HUB_SECRET}" CAMERA_CONFIG="${CAMERA_CONFIG}" \
  pm2 start go2rtc.service.js --name camera-wrapper
echo "  camera-wrapper started on port 3002 (${#CAMERAS[@]} cameras, bulk heartbeat → ${EC2_BACKEND})"


# ================================================================
# 2. GO2RTC (RTSP → WebRTC/HLS transcoder — multi-camera)
# ================================================================
echo ""
echo "[2/9] Installing go2rtc..."

# Download go2rtc binary for ARM
if [ ! -f /usr/local/bin/go2rtc ]; then
    echo "  Downloading go2rtc..."
    # Detect architecture
    ARCH=$(uname -m)
    if [[ "$ARCH" == "aarch64" ]]; then
        GO2RTC_BIN="go2rtc_linux_arm64"
    else
        GO2RTC_BIN="go2rtc_linux_arm"
    fi
    curl -fsSL "https://github.com/AlexxIT/go2rtc/releases/latest/download/${GO2RTC_BIN}" -o /tmp/go2rtc
    sudo mv /tmp/go2rtc /usr/local/bin/go2rtc
    sudo chmod +x /usr/local/bin/go2rtc
else
    echo "  go2rtc binary already exists."
fi

# go2rtc config — generate streams for ALL cameras in CAMERAS array
mkdir -p "${PI_HOME}/go2rtc"

# Write the static top of the config
cat > "${PI_HOME}/go2rtc/go2rtc.yaml" << 'GOEOF_HEADER'
api:
  listen: ":1984"
webrtc:
  listen: ":8555/tcp"
streams:
GOEOF_HEADER

# Append each camera stream
for entry in "${CAMERAS[@]}"; do
  IFS='|' read -r _name _ip _user _pass <<< "$entry"
  # URL-encode the @ in the password (common in CP Plus default passwords)
  _pass_encoded=$(echo "$_pass" | sed 's/@/%40/g')
  echo "  ${_name}:" >> "${PI_HOME}/go2rtc/go2rtc.yaml"
  echo "    - rtsp://${_user}:${_pass_encoded}@${_ip}:554/video/live?channel=1&subtype=0" >> "${PI_HOME}/go2rtc/go2rtc.yaml"
done

echo "  go2rtc.yaml generated with ${#CAMERAS[@]} stream(s):"
for entry in "${CAMERAS[@]}"; do
  IFS='|' read -r _name _ip _user _pass <<< "$entry"
  echo "    - ${_name} → ${_ip}"
done

# Systemd service for go2rtc
sudo tee /etc/systemd/system/go2rtc.service > /dev/null << GSEOF
[Unit]
Description=go2rtc media server
After=network.target

[Service]
Type=simple
User=${PI_USER}
ExecStart=/usr/local/bin/go2rtc -config ${PI_HOME}/go2rtc/go2rtc.yaml
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
GSEOF

sudo systemctl daemon-reload
sudo systemctl enable --now go2rtc
echo "  go2rtc running on port 1984 (${#CAMERAS[@]} streams)"

# NOTE: For production with Cloudflare, the named tunnel p1.awesomliving.com
# pointing to http://localhost:1984 replaces the autossh reverse tunnel in
# section 8. Cloudflare Tunnel provides authenticated, encrypted access
# without needing SSH keys or open ports on EC2. The autossh approach in
# section 8 remains the current deployment method; switch to Cloudflare
# Tunnel when the named tunnel is provisioned in the Cloudflare dashboard.


# ================================================================
# 3. MOSQUITTO (MQTT broker)
# ================================================================
echo ""
echo "[3/9] Installing Mosquitto MQTT broker..."

sudo tee /etc/mosquitto/conf.d/local.conf > /dev/null << 'MQEOF'
listener 1883
allow_anonymous true
MQEOF

sudo systemctl restart mosquitto
sudo systemctl enable mosquitto
echo "  Mosquitto running on port 1883"


# ================================================================
# 4. ZIGBEE2MQTT (Zigbee coordinator)
# ================================================================
echo ""
echo "[4/9] Installing Zigbee2MQTT..."

Z2M_DIR="${PI_HOME}/zigbee2mqtt"
if [ ! -d "$Z2M_DIR" ]; then
    echo "  Cloning zigbee2mqtt (this takes a while)..."
    cd "${PI_HOME}"
    git clone --depth 1 https://github.com/Koenkk/zigbee2mqtt.git
    cd "$Z2M_DIR"
    npm install
    npm run build
else
    echo "  zigbee2mqtt already cloned, updating..."
    cd "$Z2M_DIR"
    git pull
    npm install
    npm run build
fi

# Zigbee2MQTT configuration — persistent serial path (survives USB port changes)
mkdir -p "$Z2M_DIR/data"
DONGLE_PATH=$(ls /dev/serial/by-id/*Sonoff* 2>/dev/null | head -1 || echo "/dev/serial/by-id/PLACEHOLDER_CONNECT_DONGLE")

cat > "$Z2M_DIR/data/configuration.yaml" << ZEOF
homeassistant: false
permit_join: true
mqtt:
  base_topic: zigbee2mqtt
  server: mqtt://localhost:1883
serial:
  port: ${DONGLE_PATH}
  adapter: ember
frontend:
  port: 8080
advanced:
  log_level: info
  network_key: GENERATE
ZEOF

# Systemd service for zigbee2mqtt
sudo tee /etc/systemd/system/zigbee2mqtt.service > /dev/null << ZSEOF
[Unit]
Description=Zigbee2MQTT
After=network.target mosquitto.service

[Service]
Type=simple
User=${PI_USER}
WorkingDirectory=${Z2M_DIR}
ExecStart=/usr/bin/node ${Z2M_DIR}/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
ZSEOF

sudo systemctl daemon-reload
sudo systemctl enable zigbee2mqtt

if [ "$DONGLE_PATH" != "/dev/serial/by-id/PLACEHOLDER_CONNECT_DONGLE" ]; then
    sudo systemctl start zigbee2mqtt
    echo "  Zigbee2MQTT running with dongle at ${DONGLE_PATH}"
else
    echo "  WARNING: No Sonoff dongle detected. Zigbee2MQTT installed but not started."
    echo "  Connect the dongle and run: sudo systemctl start zigbee2mqtt"
fi


# ================================================================
# 5. MQTT BRIDGE (Zigbee → Cloud Backend)
# ================================================================
echo ""
echo "[5/9] Setting up MQTT bridge..."

MQTT_DIR="${PI_HOME}/mqtt-bridge"
mkdir -p "$MQTT_DIR"

cat > "$MQTT_DIR/package.json" << 'MPEOF'
{
  "name": "mqtt-bridge",
  "version": "2.0.0",
  "type": "module",
  "dependencies": {
    "mqtt": "^5.3.0",
    "axios": "^1.6.0",
    "js-yaml": "^4.1.0"
  }
}
MPEOF

cat > "$MQTT_DIR/.env" << ENVEOF
BACKEND_URL=${BACKEND_API_URL}
SECRET_KEY=${ZIGBEE_SECRET}
Z2M_CONFIG_PATH=${Z2M_DIR}/data/configuration.yaml
ENVEOF

# Production MQTT bridge with:
# - Motion sensor debouncing (30s cooldown, 60s false delay)
# - Presence sensor state-change detection
# - Contact sensor deduplication
# - Switch 3s dedup
# - SNZB-06P keep-alive polling every 6 hours
# - Device store for type tracking
cat > "$MQTT_DIR/mqtt.js" << 'MQTTEOF'
import mqtt from "mqtt";
import axios from "axios";
import * as yaml from "js-yaml";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Configuration ──
const BACKEND_URL = process.env.BACKEND_URL || "https://awesomliving.com/api/device-event";
const SECRET_KEY  = process.env.SECRET_KEY  || "jwt_secret_of_awesomliving_app";
const Z2M_CONFIG  = process.env.Z2M_CONFIG_PATH || "/home/pi/zigbee2mqtt/data/configuration.yaml";

// ── Device state tracking ──
const device_states = {};
const last_switch_events = {};

// ── Device store (persisted to JSON file) ──
const DEVICE_STORE_PATH = path.join(__dirname, "devices.json");

const load_devices = () => {
  try { return JSON.parse(fs.readFileSync(DEVICE_STORE_PATH, "utf8")); }
  catch { return []; }
};

const save_devices = (devices) => {
  fs.writeFileSync(DEVICE_STORE_PATH, JSON.stringify(devices, null, 2));
};

const get_devices = () => load_devices();

const upsert_device = async ({ ieee_address, name, type }) => {
  const devices = load_devices();
  const idx = devices.findIndex(d => d.ieee_address === ieee_address);
  if (idx >= 0) {
    if (name) devices[idx].name = name;
    if (type) devices[idx].type = type;
    devices[idx].last_seen = new Date().toISOString();
  } else {
    devices.push({ ieee_address, name: name || ieee_address, type: type || "unknown", last_seen: new Date().toISOString() });
  }
  save_devices(devices);
};

// ── Motion-sensor debounce ──
// PIR sensors toggle occupancy rapidly (true→false→true in seconds).
const MOTION_COOLDOWN_MS   = 30 * 1000;  // ignore repeated "true" within 30s
const MOTION_FALSE_DELAY_MS = 60 * 1000; // wait 60s of silence before sending "false"
const motion_last_sent_true = {};   // friendly_name → timestamp
const motion_false_timers  = {};   // friendly_name → setTimeout id

// Presence sensors (SNZB-06P) — distinct from PIR motion sensors
const PRESENCE_KEYS = ["presence", "occupancy_sensitivity", "occupancy_timeout"];
const is_presence_payload = (data) => PRESENCE_KEYS.some((k) => data[k] !== undefined);

// ── Zigbee2MQTT config readers ──
const get_known_ieee_set = () => {
  try {
    const config = yaml.load(fs.readFileSync(Z2M_CONFIG, "utf8"));
    return new Set(Object.keys(config.devices || {}));
  } catch { return new Set(); }
};

const get_friendly_to_ieee_map = () => {
  try {
    const config = yaml.load(fs.readFileSync(Z2M_CONFIG, "utf8"));
    const map = {};
    for (const ieee in config.devices) {
      map[config.devices[ieee].friendly_name] = ieee;
    }
    return map;
  } catch { return {}; }
};

// ── Backend sender ──
const send_to_backend = async (friendly_name, resolved_type, data) => {
  try {
    await axios.post(BACKEND_URL, {
      device: friendly_name, type: resolved_type, data
    }, { headers: { "x-zigbee-secret": SECRET_KEY }, timeout: 10000 });
    console.log(`✅ ${resolved_type} sent for ${friendly_name}`);
  } catch (err) {
    console.log("❌ Backend error:", err.message);
  }
};

// ── MQTT connection ──
const client = mqtt.connect("mqtt://localhost:1883");

client.on("connect", () => {
  console.log("✅ MQTT Connected to localhost:1883");
  console.log(`   Backend: ${BACKEND_URL}`);
  client.subscribe("zigbee2mqtt/#");
});

// ── SNZB-06P Keep-alive: poll every 6 hours ──
// The presence sensor can go quiet after ~48h; an occupancy read wakes it.
setInterval(() => {
  const presence_devices = get_devices().filter((d) => d.type === "presence");
  for (const d of presence_devices) {
    const target = d.name || d.ieee_address;
    client.publish(`zigbee2mqtt/${target}/get`, '{"occupancy":""}');
    console.log("🔄 Keep-alive poll:", target);
  }
}, 6 * 60 * 60 * 1000);

// ── Message handler ──
client.on("message", async (topic, message) => {
  try {
    const data = JSON.parse(message.toString());

    // Skip bridge management topics
    if (topic === "zigbee2mqtt/bridge/devices") return;

    if (topic === "zigbee2mqtt/bridge/event") {
      if (data.type === "device_joined" && data.data?.ieee_address) {
        const ieee = data.data.ieee_address;
        const friendly = data.data.friendly_name || ieee;
        console.log("🆕 New device joined:", ieee);
        await upsert_device({ ieee_address: ieee, name: friendly, type: "unknown" });
      }
      if (data.type === "device_interview" && data.data?.status === "successful" && data.data?.ieee_address) {
        const ieee = data.data.ieee_address;
        const exposes = data.data?.definition?.exposes || [];
        let detected_type = "unknown";
        if (exposes.some(e => e.name === "presence" || PRESENCE_KEYS.includes(e.name))) detected_type = "presence";
        else if (exposes.some(e => e.name === "occupancy")) detected_type = "motion";
        else if (exposes.some(e => e.name === "contact")) detected_type = "contact";
        else if (exposes.some(e => e.name === "action")) detected_type = "switch";
        console.log("📋 Interview done:", ieee, "→", detected_type);
        await upsert_device({ ieee_address: ieee, type: detected_type });
      }
      return;
    }

    if (topic.startsWith("zigbee2mqtt/bridge/")) return;
    if (topic.endsWith("/get") || topic.endsWith("/set")) return;

    const friendly_name = topic.split("/")[1];
    const friendly_to_ieee_map = get_friendly_to_ieee_map();
    const ieee_address = friendly_to_ieee_map[friendly_name];
    if (!ieee_address) {
      console.log("❌ IEEE not found for:", friendly_name);
      return;
    }

    const known_ieee_set = get_known_ieee_set();
    if (!known_ieee_set.has(ieee_address)) {
      console.log("🚫 Unknown device blocked:", ieee_address);
      return;
    }

    console.log("📡 Device:", friendly_name, "| Data:", JSON.stringify(data));

    // ── Switch dedup (3s window) ──
    const early_action = data.action || data.click || data.state;
    if (early_action) {
      const early_key = `${friendly_name}:${early_action}`;
      const early_now = Date.now();
      const early_stored = last_switch_events[early_key];
      if (early_stored && early_now - early_stored < 3000) {
        console.log(`🔁 Dedup: ${early_key} (${early_now - early_stored}ms)`);
        return;
      }
      last_switch_events[early_key] = early_now;
    }

    // ── Occupancy / Presence sensors ──
    if (data.occupancy !== undefined || data.presence !== undefined) {
      const payload_type = is_presence_payload(data) ? "presence" : null;
      const all_devices = get_devices();
      const stored_device = all_devices.find(d => d.ieee_address === ieee_address);
      const resolved_type = payload_type || stored_device?.type || "motion";

      // Self-heal device store if type was wrong
      if (payload_type && stored_device?.type !== payload_type) {
        await upsert_device({ ieee_address, name: friendly_name, type: payload_type });
      }

      const current_value = data.presence !== undefined ? data.presence : data.occupancy;
      await upsert_device({ ieee_address, name: friendly_name });

      // ── PRESENCE sensors: send every state change (no debounce) ──
      if (resolved_type === "presence") {
        if (!(friendly_name in device_states)) device_states[friendly_name] = null;
        const state_changed = device_states[friendly_name] !== current_value;
        device_states[friendly_name] = current_value;
        if (state_changed) {
          console.log(`🧘 Presence state: ${current_value}`);
          await send_to_backend(friendly_name, resolved_type, data);
        }
        return;
      }

      // ── MOTION sensors: debounced ──
      const now = Date.now();

      if (current_value === true) {
        // Cancel any pending "room cleared" timer
        if (motion_false_timers[friendly_name]) {
          clearTimeout(motion_false_timers[friendly_name]);
          motion_false_timers[friendly_name] = null;
          console.log(`⏱️ Cancelled pending false for: ${friendly_name}`);
        }

        // Only send if cooldown expired
        const last_sent = motion_last_sent_true[friendly_name] || 0;
        if (now - last_sent >= MOTION_COOLDOWN_MS) {
          device_states[friendly_name] = true;
          motion_last_sent_true[friendly_name] = now;
          console.log(`🚶 Motion: true`);
          await send_to_backend(friendly_name, resolved_type, data);
        } else {
          console.log(`⏳ Motion cooldown: ${friendly_name} (${Math.round((MOTION_COOLDOWN_MS - (now - last_sent)) / 1000)}s left)`);
        }
      } else {
        // occupancy: false — delay before confirming room is clear
        if (!motion_false_timers[friendly_name]) {
          console.log(`⏱️ Motion false delayed ${MOTION_FALSE_DELAY_MS / 1000}s for: ${friendly_name}`);
          motion_false_timers[friendly_name] = setTimeout(async () => {
            motion_false_timers[friendly_name] = null;
            device_states[friendly_name] = false;
            console.log(`🚶 Motion: false (confirmed after ${MOTION_FALSE_DELAY_MS / 1000}s silence)`);
            await send_to_backend(friendly_name, resolved_type, { ...data, occupancy: false });
          }, MOTION_FALSE_DELAY_MS);
        }
      }
      return;
    }

    // ── Switch / Emergency button ──
    const switch_action = data.action || data.click || data.state;
    if (switch_action) {
      await upsert_device({ ieee_address, name: friendly_name, type: "switch" });
      console.log("🔘 Switch:", switch_action);
      await send_to_backend(friendly_name, "switch", data);
    }

    // ── Contact sensors (door/window) ──
    if (data.contact !== undefined) {
      const contact_key = `contact:${friendly_name}`;
      if (!(contact_key in device_states)) device_states[contact_key] = null;
      const contact_changed = device_states[contact_key] !== data.contact;
      device_states[contact_key] = data.contact;
      await upsert_device({ ieee_address, name: friendly_name, type: "contact" });
      if (contact_changed) {
        console.log("🚪 Contact:", data.contact ? "CLOSED" : "OPEN");
        await send_to_backend(friendly_name, "contact", data);
      }
    }
  } catch (err) {
    console.log("❌ Error:", err.message);
  }
});

client.on("error", (err) => {
  console.log("❌ MQTT Error:", err.message);
});

console.log("🚀 MQTT bridge starting...");
MQTTEOF

cd "$MQTT_DIR"
npm install --silent
pm2 delete mqtt-bridge 2>/dev/null || true
pm2 start mqtt.js --name mqtt-bridge --cwd "$MQTT_DIR"
echo "  MQTT bridge started → ${BACKEND_API_URL}"


# ================================================================
# 6. GLK BRIDGE (TCP :8766 for GLK Sleep Monitor)
# ================================================================
# All fixes from testing applied:
#   - Lesson #27: Bluetooth adapter power on at boot
#   - Lesson #29: bleak installed for both pi user AND root
#   - Hex-dump bridge with full frame logging
#   - Time sync loop fix: 4-byte epoch ACK (not 6-byte BCD)
#   - Compact WiFi device info (18-byte frame, not 53-byte 4G)
#   - Backend route fix: local /api/glk/vitals, remote /api/health
#   - Sleep stage (0x4E) and emergency (0x0D) forwarding
#   - BLE provisioning with 25s timeout, write-with-response fallback
#   - glk_provision.py for scan/pair (called by server.js)
# ================================================================
echo ""
echo "[6/9] Setting up GLK Sleep Monitor bridge..."

GLK_DIR="${PI_HOME}/glk-bridge"
mkdir -p "$GLK_DIR"

# Install Python BLE dependencies (Lesson #29: install for BOTH pi and root)
echo "  Installing Python BLE dependencies..."
sudo apt-get install -y python3-pip python3-dev libglib2.0-dev bluetooth bluez
pip3 install --break-system-packages bleak dbus-fast 2>/dev/null || pip3 install bleak dbus-fast
sudo pip3 install --break-system-packages bleak dbus-fast 2>/dev/null || sudo pip3 install bleak dbus-fast

# Lesson #27: Enable Bluetooth adapter at boot (needed for GLK BLE provisioning)
sudo systemctl enable bluetooth
sudo systemctl start bluetooth
sudo rfkill unblock bluetooth
sleep 1
sudo hciconfig hci0 up 2>/dev/null || true
sudo bluetoothctl power on 2>/dev/null || true
sudo usermod -aG bluetooth ${PI_USER} 2>/dev/null || true

# Ensure Bluetooth powers on at every boot (Lesson #27)
if ! grep -q "hciconfig hci0 up" /etc/rc.local 2>/dev/null; then
    sudo sed -i '/^exit 0/i sudo hciconfig hci0 up 2>/dev/null || true' /etc/rc.local 2>/dev/null || true
fi
echo "  Bluetooth adapter powered on (will auto-start on boot)"

# ── Deploy glk_protocol.py (full tested version with self-test) ──
cat > "$GLK_DIR/glk_protocol.py" << 'GLKPROTOEOF'
#!/usr/bin/env python3
"""
glk_protocol.py — GLK AI Smart Sleep Monitor protocol library.
Verified against live packet captures. Treat this as source of truth.

Key fixes baked in:
  - Frame envelope XOR checksum (0x82 start byte IS included)
  - Compact WiFi device info: 18 bytes, NOT the 53-byte 4G layout from PDF
  - Time Sync ACK: 4-byte epoch (NOT 6-byte BCD — that causes the 7x loop)
  - Login ACK: assigns current Unix timestamp as 4-byte code
  - BLE provisioning: length = content + 4, chunks <= 20 bytes

Run self-test:  python3 glk_protocol.py --selftest
"""
from __future__ import annotations
import struct
import time as _time
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
    for b in data: c ^= b
    return c

def build_frame(seq: int, cmd: int, payload: bytes = b"", ack: int = 0x01) -> bytes:
    body = bytes([ack & 0xFF, seq & 0xFF, cmd & 0xFF]) + payload
    length = len(body) + 1
    head = bytes([FRAME_START, length & 0xFF]) + body
    return head + bytes([xor_checksum(head)])

def parse_frame(frame: bytes) -> dict | None:
    if len(frame) < 6 or frame[0] != FRAME_START: return None
    length = frame[1]
    total = 2 + length
    if len(frame) < total: return None
    frame = frame[:total]
    if xor_checksum(frame[:-1]) != frame[-1]: return None
    return {"ack": frame[2], "seq": frame[3], "cmd": frame[4],
            "payload": frame[5:-1], "checksum": frame[-1], "raw": frame}

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

def build_login_ack(seq: int, code: bytes | None = None) -> bytes:
    """Login ACK assigns a 4-byte code (current Unix timestamp)."""
    if code is None: code = struct.pack(">I", int(_time.time()))
    if len(code) != 4: raise ValueError("login code must be exactly 4 bytes")
    return build_frame(seq, CMD_LOGIN, payload=code)

def parse_device_info(frame: dict) -> dict:
    """Compact WiFi variant: 18 bytes (NOT 53-byte 4G layout from PDF)."""
    raw = frame["raw"]
    if len(raw) < 18: return {}
    return {"sn": sn_decode(raw[5:11]), "firmware": raw[11:13].hex(),
            "verification_code": raw[13:17].hex(), "device_type": "wifi-compact"}

def build_device_info_ack(seq: int) -> bytes:
    return build_frame(seq, CMD_DEVICE_INFO, payload=b"\x00")

def build_time_sync_ack(seq: int, when: datetime | None = None) -> bytes:
    """4-byte big-endian Unix timestamp — THE FIX for the 7x Time Sync loop.
    Old 6-byte BCD caused payload length mismatch → device rejected every ACK."""
    epoch = int(when.timestamp()) if when else int(_time.time())
    return build_frame(seq, CMD_TIME_SYNC, payload=struct.pack(">I", epoch))

def build_time_sync_ack_bcd(seq: int, when: datetime | None = None) -> bytes:
    """DEPRECATED: 6-byte BCD. Kept for debug ONLY — causes 7x loop in production."""
    when = when or datetime.now(timezone.utc)
    bcd = lambda n: int(f"{n:02d}", 16)
    payload = bytes([bcd(when.year % 100), bcd(when.month), bcd(when.day),
                     bcd(when.hour), bcd(when.minute), bcd(when.second)])
    return build_frame(seq, CMD_TIME_SYNC, payload=payload)

# ── BLE Provisioning (one-time setup; sleep data does NOT come over BLE) ──
BLE_SERVICE_UUID = "0000fff0-0000-1000-8000-00805f9b34fb"
BLE_WRITE_CHAR   = "0000fff1-0000-1000-8000-00805f9b34fb"
BLE_NOTIFY_CHAR  = "0000fff2-0000-1000-8000-00805f9b34fb"
BLE_FORBIDDEN    = ("fe59", "8ec9")  # NEVER write here (DFU bootloader)
BLE_MSG_WIFI   = 0x1F
BLE_MSG_SERVER = 0x23

def ble_content(*values: str) -> bytes:
    return ",".join(f'"{v}"' for v in values).encode("ascii")

def build_ble_config(msg_type: int, *values: str) -> bytes:
    content = ble_content(*values)
    length = len(content) + 4
    return (bytes([0xCD, msg_type & 0xFF])
            + struct.pack(">H", length) + content + b"\xff\xff\xff\xff")

def chunk_ble(packet: bytes, size: int = 20) -> list[bytes]:
    return [packet[i:i + size] for i in range(0, len(packet), size)]

def build_wifi_config(ssid: str, password: str) -> list[bytes]:
    return chunk_ble(build_ble_config(BLE_MSG_WIFI, ssid, password))

def build_server_config(pi_ip: str, port: str = "8766") -> list[bytes]:
    return chunk_ble(build_ble_config(BLE_MSG_SERVER, pi_ip, str(port)))

# ── Self-test ──
def _selftest() -> int:
    ok = True
    def check(name, cond):
        nonlocal ok
        print(f"  [{'PASS' if cond else 'FAIL'}] {name}")
        ok = ok and cond
    print("Frame envelope + checksum vs CAPTURED frames")
    login = bytes.fromhex("820A01A603332014813081".replace(" ", "") + "1B")
    dinfo = bytes.fromhex("821001550433201481308105" + "70D600000056")
    check("login checksum verifies", xor_checksum(login[:-1]) == login[-1])
    check("device-info checksum verifies", xor_checksum(dinfo[:-1]) == dinfo[-1])
    lf = parse_frame(login); df = parse_frame(dinfo)
    check("login frame parses", lf is not None and lf["cmd"] == CMD_LOGIN)
    check("device-info frame parses", df is not None and df["cmd"] == CMD_DEVICE_INFO)
    print("Field extraction")
    check("login SN == 332014813081", parse_login(lf)["sn"] == "332014813081")
    di = parse_device_info(df)
    check("device-info SN == 332014813081", di["sn"] == "332014813081")
    check("firmware == 0570", di["firmware"] == "0570")
    check("device_type == wifi-compact", di["device_type"] == "wifi-compact")
    print("Builders round-trip")
    ack = build_login_ack(0xA6); pack = parse_frame(ack)
    check("login ACK valid frame", pack is not None and pack["cmd"] == CMD_LOGIN)
    check("login ACK 4-byte code", len(pack["payload"]) == 4)
    login_epoch = struct.unpack(">I", pack["payload"])[0]
    check("login ACK code is current epoch", login_epoch > 1704067200)
    print("Time Sync ACK format")
    ts_ack = build_time_sync_ack(0x5C); ts_frame = parse_frame(ts_ack)
    check("time sync ACK valid frame", ts_frame is not None and ts_frame["cmd"] == CMD_TIME_SYNC)
    check("time sync ACK payload is 4 bytes (not 6)", len(ts_frame["payload"]) == 4)
    ts_epoch = struct.unpack(">I", ts_frame["payload"])[0]
    check("time sync ACK epoch is current", ts_epoch > 1704067200)
    diack = parse_frame(build_device_info_ack(0x55))
    check("device-info ACK valid frame", diack is not None and diack["cmd"] == CMD_DEVICE_INFO)
    print("BLE provisioning length math")
    wifi = build_ble_config(BLE_MSG_WIFI, "AwesoHome_24G", "Awesom@2026")
    srv = build_ble_config(BLE_MSG_SERVER, "192.168.1.14", "8766")
    check("WiFi chunks <= 20 bytes each", all(len(c) <= 20 for c in chunk_ble(wifi)))
    check("server chunks <= 20 bytes each", all(len(c) <= 20 for c in chunk_ble(srv)))
    print("\nRESULT:", "ALL CHECKS PASSED" if ok else "FAILURES ABOVE")
    return 0 if ok else 1

if __name__ == "__main__":
    import sys
    if "--selftest" in sys.argv: raise SystemExit(_selftest())
    print(__doc__)
GLKPROTOEOF

# ── Deploy glk_bridge.py (full tested version with all fixes) ──
cat > "$GLK_DIR/glk_bridge.py" << 'GLKBRIDGEEOF'
#!/usr/bin/env python3
"""
glk_bridge.py — TCP bridge for the GLK AI Smart Sleep Monitor.

Listens on TCP port 8766. When a GLK device connects (after BLE provisioning),
it handles the full handshake (login -> time sync -> device info) and then
receives ~1 Hz realtime vitals, forwarding them to the Awesom Living backend.

All fixes from testing:
  - Hex dump of every TCP read for debugging
  - TCP_NODELAY to prevent Nagle buffering on small ACK frames
  - Time sync: 4-byte epoch ACK (fixes the 7x loop caused by 6-byte BCD)
  - Compact device info: accepts 18-byte WiFi frame (not 53-byte 4G)
  - Sleep stage (0x4E) forwarding
  - Emergency (0x0D) forwarding
  - time_sync_count tracking per connection
  - Configurable log level, time format debug knob

Debug env vars:
    GLK_TIME_FORMAT=epoch|bcd   — switch Time Sync ACK format (default: epoch)
    GLK_SKIP_TIME_ACK=1         — don't reply to Time Sync at all (test only)
    GLK_LOG_LEVEL=DEBUG         — show extra detail
"""
from __future__ import annotations
import asyncio, json, logging, os, signal, socket, struct, sys, time
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.error import URLError

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from glk_protocol import (
    FRAME_START, CMD_LOGIN, CMD_TIME_SYNC, CMD_DEVICE_INFO,
    CMD_REALTIME, CMD_SLEEP_STAGE, CMD_EMERGENCY,
    parse_frame, parse_login, parse_device_info,
    build_login_ack, build_device_info_ack,
    build_time_sync_ack, build_time_sync_ack_bcd,
    build_frame, sn_decode,
)

# ── Configuration ──
LISTEN_PORT = int(os.environ.get("GLK_BRIDGE_PORT", "8766"))
LOCAL_BACKEND_URL = os.environ.get("GLK_BACKEND_URL", "http://localhost:4000")
if not LOCAL_BACKEND_URL.endswith("/api/glk/vitals"):
    LOCAL_BACKEND_URL = LOCAL_BACKEND_URL.rstrip("/") + "/api/glk/vitals"
REMOTE_BACKEND_URL = os.environ.get("REMOTE_BACKEND_URL", "")
if REMOTE_BACKEND_URL and not REMOTE_BACKEND_URL.endswith("/api/health"):
    REMOTE_BACKEND_URL = REMOTE_BACKEND_URL.rstrip("/") + "/api/health"
BACKEND_URL = LOCAL_BACKEND_URL
SECRET_KEY = os.environ.get("HUB_SECRET_KEY", "jwt_secret_of_awesomliving_app")
FORWARD_INTERVAL = float(os.environ.get("GLK_FORWARD_INTERVAL", "5"))
IDLE_TIMEOUT = float(os.environ.get("GLK_IDLE_TIMEOUT", "600"))
TIME_FORMAT = os.environ.get("GLK_TIME_FORMAT", "epoch").lower()
SKIP_TIME_ACK = os.environ.get("GLK_SKIP_TIME_ACK", "0") == "1"
LOG_LEVEL = os.environ.get("GLK_LOG_LEVEL", "INFO").upper()

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s [glk-bridge] %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("glk-bridge")

CMD_NAMES = {CMD_LOGIN: "LOGIN", CMD_TIME_SYNC: "TIME_SYNC",
             CMD_DEVICE_INFO: "DEVICE_INFO", CMD_REALTIME: "REALTIME",
             CMD_SLEEP_STAGE: "SLEEP_STAGE", CMD_EMERGENCY: "EMERGENCY"}
STATUS_MAP = {0: "initializing", 1: "in_bed", 2: "apnea_suspected",
              3: "snoring", 4: "out_of_bed", 5: "life_abnormality",
              6: "light_sleep"}

def cmd_name(cmd): return CMD_NAMES.get(cmd, f"0x{cmd:02X}")

def get_time_sync_ack(seq):
    if TIME_FORMAT == "bcd":
        ack = build_time_sync_ack_bcd(seq)
        log.warning("  Time Sync ACK (BCD/6-byte — DEBUG ONLY): %s", ack.hex())
        return ack
    ack = build_time_sync_ack(seq)
    log.info("  Time Sync ACK (epoch/4-byte): %s", ack.hex())
    return ack

def parse_realtime(frame):
    p = frame["payload"]
    if len(p) < 11: return {}
    # Corrected byte layout (Aug 2026):
    # p[0:2]  = protocol markers (constant 0x6A, 0x8A) — NOT vitals
    # p[2:4]  = 16-bit BE second counter — NOT status/movement
    # p[4]    = heart rate (bpm, 0 = no contact / out of bed)
    # p[5]    = respiration rate (brpm, 0 = no contact / apnea)
    # p[6]    = status code (0-5 per STATUS_MAP)
    # p[7]    = battery level (percentage, often 100)
    # p[8]    = reserved (usually 0)
    # p[9]    = signal quality (usually 100)
    # p[10]   = body movement intensity (0-255)
    sc = p[6]
    IN_BED_STATUSES = {1, 2, 3, 5, 6}  # everything except 0 (init) and 4 (out_of_bed)
    return {
        "heart_rate": p[4] if p[4] != 0xFF else None,
        "respiration_rate": p[5] if p[5] != 0xFF else None,
        "status_code": sc, "status": STATUS_MAP.get(sc, f"unknown_{sc}"),
        "in_bed": sc in IN_BED_STATUSES, "out_of_bed": sc == 4,
        "apnea_suspected": sc == 2, "snoring": sc == 3,
        "body_movement": p[10] if len(p) > 10 else 0,
        "battery_level": p[7] if len(p) > 7 else None,
        "life_abnormality": sc == 5,
        "timer_counter": (p[2] << 8) | p[3],
    }

def forward_to_backend(sn, data):
    payload = json.dumps({"serial_number": sn, "secret_key": SECRET_KEY,
                          "data": data, "timestamp": datetime.now(timezone.utc).isoformat()}).encode("utf-8")
    ok = False
    req = Request(LOCAL_BACKEND_URL, data=payload,
                  headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urlopen(req, timeout=5) as resp: ok = 200 <= resp.status < 300
    except (URLError, OSError) as e:
        log.warning("Local backend POST failed: %s", e)
    if REMOTE_BACKEND_URL:
        req2 = Request(REMOTE_BACKEND_URL, data=payload,
                       headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urlopen(req2, timeout=10): pass
        except (URLError, OSError): pass
    return ok

async def handle_client(reader, writer):
    peer = writer.get_extra_info("peername")
    log.info("Connection from %s", peer)
    sock = writer.get_extra_info("socket")
    if sock:
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        log.info("  TCP_NODELAY enabled")
    sn = "UNKNOWN"
    last_forward = 0.0
    time_sync_count = 0
    buf = bytearray()
    try:
        while True:
            try: data = await asyncio.wait_for(reader.read(4096), timeout=IDLE_TIMEOUT)
            except asyncio.TimeoutError:
                log.info("sn=%s idle timeout, closing", sn); break
            if not data: break
            log.info("sn=%s << RECV %d bytes: %s", sn, len(data), data.hex())
            buf.extend(data)
            while len(buf) >= 6:
                if buf[0] != FRAME_START:
                    idx = buf.find(bytes([FRAME_START]), 1)
                    if idx == -1:
                        skipped = bytes(buf); buf.clear()
                        log.info("sn=%s  !! skipped %d non-frame bytes: %s", sn, len(skipped), skipped.hex())
                        break
                    else:
                        log.info("sn=%s  !! skipped %d non-frame bytes: %s", sn, idx, bytes(buf[:idx]).hex())
                        del buf[:idx]; continue
                if len(buf) < 2: break
                total = 2 + buf[1]
                if len(buf) < total: break
                raw = bytes(buf[:total]); del buf[:total]
                frame = parse_frame(raw)
                if frame is None:
                    log.warning("sn=%s BAD FRAME (checksum?): %s", sn, raw.hex()); continue
                cmd, seq, payload = frame["cmd"], frame["seq"], frame["payload"]
                log.info("sn=%s << FRAME cmd=%s seq=0x%02X payload(%dB)=%s",
                         sn, cmd_name(cmd), seq, len(payload), payload.hex() if payload else "(empty)")

                if cmd == CMD_LOGIN:
                    info = parse_login(frame)
                    sn = info.get("sn", "UNKNOWN"); time_sync_count = 0
                    log.info("  Login from sn=%s", sn)
                    ack = build_login_ack(seq)
                    log.info("sn=%s >> SEND LOGIN_ACK: %s", sn, ack.hex())
                    writer.write(ack); await writer.drain()

                elif cmd == CMD_DEVICE_INFO:
                    info = parse_device_info(frame)
                    dev_sn = info.get("sn", sn)
                    log.info("  Device info sn=%s firmware=%s type=%s",
                             dev_sn, info.get("firmware", "?"), info.get("device_type", "?"))
                    if dev_sn != "UNKNOWN": sn = dev_sn
                    ack = build_device_info_ack(seq)
                    log.info("sn=%s >> SEND DEVICE_INFO_ACK: %s", sn, ack.hex())
                    writer.write(ack); await writer.drain()

                elif cmd == CMD_TIME_SYNC:
                    time_sync_count += 1
                    log.info("  Time sync request #%d (payload=%s)",
                             time_sync_count, payload.hex() if payload else "(empty)")
                    if SKIP_TIME_ACK:
                        log.info("  GLK_SKIP_TIME_ACK=1 — NOT sending ACK")
                    else:
                        ack = get_time_sync_ack(seq)
                        log.info("sn=%s >> SEND TIME_SYNC_ACK (#%d): %s", sn, time_sync_count, ack.hex())
                        writer.write(ack); await writer.drain()

                elif cmd == CMD_REALTIME:
                    vitals = parse_realtime(frame)
                    if vitals:
                        now = time.monotonic()
                        if now - last_forward >= FORWARD_INTERVAL:
                            last_forward = now
                            log.info("  VITALS sn=%s HR=%s RR=%s status=%s battery=%s",
                                     sn, vitals.get("heart_rate"), vitals.get("respiration_rate"),
                                     vitals.get("status"), vitals.get("battery_level"))
                            asyncio.get_event_loop().run_in_executor(None, forward_to_backend, sn, vitals)

                elif cmd == CMD_SLEEP_STAGE:
                    log.info("  Sleep stage frame (%d bytes)", len(raw))
                    asyncio.get_event_loop().run_in_executor(
                        None, forward_to_backend, sn, {"type": "sleep_stage", "raw_hex": raw.hex()})

                elif cmd == CMD_EMERGENCY:
                    log.warning("  EMERGENCY frame from sn=%s!", sn)
                    asyncio.get_event_loop().run_in_executor(
                        None, forward_to_backend, sn, {"type": "emergency", "raw_hex": raw.hex()})

                else:
                    log.info("  UNKNOWN cmd=0x%02X (%d payload bytes)", cmd, len(payload))

    except (ConnectionResetError, BrokenPipeError):
        log.info("sn=%s connection reset (time_syncs=%d)", sn, time_sync_count)
    except Exception: log.exception("sn=%s unexpected error", sn)
    finally:
        writer.close()
        try: await writer.wait_closed()
        except: pass
        log.info("sn=%s disconnected (time_syncs=%d)", sn, time_sync_count)

async def run_server():
    server = await asyncio.start_server(handle_client, "0.0.0.0", LISTEN_PORT)
    addrs = ", ".join(str(s.getsockname()) for s in server.sockets)
    log.info("GLK bridge listening on %s", addrs)
    log.info("  Time format: %s  |  Skip time ACK: %s", TIME_FORMAT, SKIP_TIME_ACK)
    stop = asyncio.Event()
    loop = asyncio.get_event_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, lambda: stop.set())
    async with server: await stop.wait()
    log.info("GLK bridge stopped")

def main():
    log.info("Starting GLK bridge (port=%d, local=%s, remote=%s, interval=%.0fs)",
             LISTEN_PORT, LOCAL_BACKEND_URL, REMOTE_BACKEND_URL or "(none)", FORWARD_INTERVAL)
    asyncio.run(run_server())

if __name__ == "__main__":
    main()
GLKBRIDGEEOF

# ── Deploy glk_provision.py (BLE scan + pair, called by server.js) ──
cat > "$GLK_DIR/glk_provision.py" << 'GLKPROVEOF'
#!/usr/bin/env python3
"""
glk_provision.py — BLE scan & provisioning for the GLK AI Smart Sleep Monitor.

Called by server.js:
    POST /api/glk/scan     ->  python3 glk_provision.py scan --timeout 8
    POST /api/glk/pair     ->  python3 glk_provision.py provision \
                                  --address <MAC> --ssid <SSID> --password <PWD> \
                                  --pi-ip <IP> --port 8766

The device advertises as "LZ-OTA <12-digit serial>" on BLE. We scan for that
prefix, then write WiFi (0x1F) and server (0x23) config packets to GATT
characteristic fff1, subscribing to fff2 for the device's reply.

After provisioning, the device joins 2.4 GHz WiFi and streams sleep data
over TCP to the Pi on port 8766. BLE is NOT used again.
"""
from __future__ import annotations
import argparse, asyncio, json, sys, os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from glk_protocol import (
    BLE_SERVICE_UUID, BLE_WRITE_CHAR, BLE_NOTIFY_CHAR,
    build_wifi_config, build_server_config,
)

def _dbg(msg):
    print(f"[GLK] {msg}", file=sys.stderr, flush=True)

async def scan_devices(timeout=8.0):
    from bleak import BleakScanner
    _dbg(f"Starting BLE scan (timeout={timeout}s) ...")
    devices = []
    discovered = await BleakScanner.discover(timeout=timeout, return_adv=True)
    _dbg(f"Scan complete — {len(discovered)} total BLE devices seen")
    for device, adv_data in discovered.values():
        name = adv_data.local_name or device.name or ""
        if name.startswith("LZ-OTA"):
            parts = name.split()
            serial = parts[1] if len(parts) > 1 else "unknown"
            devices.append({"address": device.address, "name": name,
                            "serial": serial, "rssi": adv_data.rssi})
            _dbg(f"  Found GLK: {name} @ {device.address} (RSSI {adv_data.rssi})")
    _dbg(f"GLK devices found: {len(devices)}")
    return devices

async def _write_chunks(client, chunks, label):
    """Write BLE chunks — try write-with-response, fall back to without."""
    try:
        for i, chunk in enumerate(chunks):
            _dbg(f"  Writing {label} chunk {i+1}/{len(chunks)} (response=True): {chunk.hex()}")
            await client.write_gatt_char(BLE_WRITE_CHAR, chunk, response=True)
            _dbg(f"  Chunk {i+1} acknowledged")
            await asyncio.sleep(0.3)
    except Exception as e:
        _dbg(f"  Write-with-response failed: {e}")
        _dbg(f"  Falling back to write WITHOUT response ...")
        for i, chunk in enumerate(chunks):
            _dbg(f"  Writing {label} chunk {i+1}/{len(chunks)} (response=False): {chunk.hex()}")
            await client.write_gatt_char(BLE_WRITE_CHAR, chunk, response=False)
            await asyncio.sleep(0.3)

async def provision_device(address, ssid, password, pi_ip, port="8766", timeout=15.0):
    from bleak import BleakClient
    result = {"success": False, "address": address, "wifi_ok": False,
              "server_ok": False, "error": None}
    reply_event = asyncio.Event()
    last_reply = bytearray()
    def notification_handler(sender, data):
        nonlocal last_reply
        last_reply[:] = data
        _dbg(f"  [NOTIFY] Reply on fff2: {data.hex()} ({len(data)} bytes)")
        reply_event.set()
    try:
        _dbg(f"Connecting to {address} (timeout={timeout}s) ...")
        async with BleakClient(address, timeout=timeout) as client:
            if not client.is_connected:
                result["error"] = "Failed to connect"; return result
            _dbg(f"Connected: {client.is_connected}")
            for service in client.services:
                _dbg(f"  Service: {service.uuid}")
                for char in service.characteristics:
                    _dbg(f"    Char: {char.uuid} [{', '.join(char.properties)}]")
            _dbg(f"Subscribing to notifications on {BLE_NOTIFY_CHAR} ...")
            await client.start_notify(BLE_NOTIFY_CHAR, notification_handler)
            await asyncio.sleep(0.5)

            # Step 1: WiFi config (0x1F)
            wifi_chunks = build_wifi_config(ssid, password)
            _dbg(f"WiFi config: {len(wifi_chunks)} chunks")
            reply_event.clear()
            await _write_chunks(client, wifi_chunks, "WiFi")
            _dbg("Waiting for WiFi config reply (25s) ...")
            try:
                await asyncio.wait_for(reply_event.wait(), timeout=25.0)
            except asyncio.TimeoutError:
                result["error"] = "No reply for WiFi config (25s timeout)"
                _dbg("TIMEOUT — possible causes: already provisioned, 5GHz SSID, not in pairing mode")
                return result
            _dbg(f"WiFi reply: {last_reply.hex()}")
            if len(last_reply) >= 5 and last_reply[1] == 0x1F:
                result["wifi_ok"] = (last_reply[4] == 0x00)
                _dbg(f"WiFi config {'SUCCESS' if result['wifi_ok'] else 'REJECTED'}")
            if not result["wifi_ok"]:
                result["error"] = "WiFi config rejected by device"; return result
            await asyncio.sleep(1.0)

            # Step 2: Server config (0x23)
            server_chunks = build_server_config(pi_ip, port)
            _dbg(f"Server config: {len(server_chunks)} chunks")
            reply_event.clear(); last_reply.clear()
            await _write_chunks(client, server_chunks, "Server")
            _dbg("Waiting for server config reply (25s) ...")
            try:
                await asyncio.wait_for(reply_event.wait(), timeout=25.0)
            except asyncio.TimeoutError:
                result["error"] = "No reply for server config (25s timeout)"; return result
            _dbg(f"Server reply: {last_reply.hex()}")
            if len(last_reply) >= 5 and last_reply[1] == 0x23:
                result["server_ok"] = (last_reply[4] == 0x00)
                _dbg(f"Server config {'SUCCESS' if result['server_ok'] else 'REJECTED'}")
            if not result["server_ok"]:
                result["error"] = "Server config rejected by device"; return result
            await client.stop_notify(BLE_NOTIFY_CHAR)
            result["success"] = True; result["error"] = None
            _dbg("*** PROVISIONING COMPLETE ***")
    except Exception as e:
        result["error"] = str(e); _dbg(f"ERROR: {e}")
    return result

def main():
    parser = argparse.ArgumentParser(description="GLK BLE Provisioning")
    sub = parser.add_subparsers(dest="command")
    scan_p = sub.add_parser("scan")
    scan_p.add_argument("--timeout", type=float, default=8.0)
    prov_p = sub.add_parser("provision")
    prov_p.add_argument("--address", required=True)
    prov_p.add_argument("--ssid", required=True)
    prov_p.add_argument("--password", required=True)
    prov_p.add_argument("--pi-ip", required=True)
    prov_p.add_argument("--port", default="8766")
    args = parser.parse_args()
    if args.command == "scan":
        print(json.dumps(asyncio.run(scan_devices(timeout=args.timeout))))
    elif args.command == "provision":
        print(json.dumps(asyncio.run(provision_device(
            address=args.address, ssid=args.ssid, password=args.password,
            pi_ip=args.pi_ip, port=args.port))))
    else:
        parser.print_help(); sys.exit(1)

if __name__ == "__main__":
    main()
GLKPROVEOF

chmod +x "$GLK_DIR/glk_protocol.py" "$GLK_DIR/glk_bridge.py" "$GLK_DIR/glk_provision.py"

# Systemd service for glk-bridge
sudo tee /etc/systemd/system/glk-bridge.service > /dev/null << GLKSVCEOF
[Unit]
Description=GLK Sleep Monitor Bridge (TCP :8766)
After=network.target

[Service]
Type=simple
User=${PI_USER}
Environment=REMOTE_BACKEND_URL=${EC2_BACKEND}
Environment=HUB_SECRET_KEY=${HUB_SECRET}
Environment=GLK_BRIDGE_PORT=8766
Environment=GLK_TIME_FORMAT=epoch
ExecStart=/usr/bin/python3 ${GLK_DIR}/glk_bridge.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
GLKSVCEOF

sudo systemctl daemon-reload
sudo systemctl enable --now glk-bridge
echo "  GLK bridge running on port 8766"
echo "  GLK provision available: python3 ${GLK_DIR}/glk_provision.py scan"


# ================================================================
# 7. PI DASHBOARD (Git repo — React + Express, port 4000)
# ================================================================
# The Pi Dashboard is a full-stack app served from a Git repo:
#   - Frontend: React 19 + Vite 8 (built to frontend/dist/, served by Express)
#   - Backend: Express 5 (ESM) on port 4000
#
# Flow: Login → Hub Setup modal (first time) → Devices dashboard
#
# The backend includes:
#   - Hub heartbeat (30s interval to /api/hub/heartbeat)
#   - Hub setup endpoints (GET/POST /api/hub/setup)
#   - GLK vitals proxy (/api/glk/vitals → cloud /api/health)
#   - Device management (assign, delete, camera pairing)
#   - MQTT client for Zigbee2MQTT events
#
# Config persisted in ~/awesomliving-data/hub-config.json
# Devices persisted in ~/awesomliving-data/devices.json
# ================================================================
echo ""
echo "[7/9] Setting up Pi Dashboard (Git repo clone + React build)..."

DASHBOARD_DIR="${REPO_DIR}"
DASHBOARD_REPO="https://github.com/SyedSameer826/VAYUZ-awesom-living-Pie-Dashboard.git"
DATA_DIR="${PI_HOME}/awesomliving-data"

# Clone the repo (or pull if already present)
if [ -d "${DASHBOARD_DIR}/.git" ]; then
    echo "  Repo already exists — pulling latest..."
    cd "${DASHBOARD_DIR}"
    git pull
else
    if [ -d "${DASHBOARD_DIR}" ]; then
        echo "  Old non-git dashboard found — backing up..."
        mv "${DASHBOARD_DIR}" "${DASHBOARD_DIR}.backup.$(date +%Y%m%d%H%M%S)"
    fi
    echo "  Cloning Pi Dashboard repo..."
    git clone "${DASHBOARD_REPO}" "${DASHBOARD_DIR}"
fi

# ── Post-clone code patches ─────────────────────────────────────────────
# These fixes exist locally but haven't been pushed to GitHub yet.
# The patches ensure the Pi gets correct code regardless of repo state.
# Once pushed to GitHub, these become harmless no-ops (overwrite with same).
echo "  Applying code patches (camera scan + device sync + backend URL)..."

# Patch 1: deviceStore.js — fix REMOTE_BACKEND URL (old IP → domain)
sed -i 's|"http://51.20.102.125"|"https://awesomliving.com"|' "${DASHBOARD_DIR}/backend/services/deviceStore.js"

# Patch 2: mqttClient.js — add Z2M device sync handler
# The GitHub version has NO handler for zigbee2mqtt/bridge/devices, so
# Zigbee devices never get written to devices.json and the Device Listing
# page shows 0 devices. This complete file adds the sync handler.
cat > "${DASHBOARD_DIR}/backend/mqtt/mqttClient.js" << 'MQTTCLIENTEOF'
import mqtt from "mqtt";
import { getIO } from "../socket/socket.js";
import fs from "fs";
import yaml from "js-yaml";

import { pendingDeletes } from "../utils/deleteState.js";
import { deleteDevice, upsertDevice } from "../services/deviceStore.js";
const CONFIG_PATH = "/home/pi/zigbee2mqtt/data/configuration.yaml";
const client = mqtt.connect("mqtt://localhost");

client.on("connect", () => {
  console.log("MQTT Connected");

  client.subscribe("zigbee2mqtt/#");
});
client.on("message", (topic, message) => {
  const data = message.toString();

  // ── When Z2M publishes its device list (on startup, and every time a
  //    device joins or leaves), upsert each real device into devices.json
  //    so it appears in the Devices page as "unmapped" and ready to map.
  if (topic === "zigbee2mqtt/bridge/devices") {
    try {
      const device_list = JSON.parse(data);
      for (const dev of device_list) {
        // Skip the coordinator itself and any non-end/router devices.
        if (dev.type === "Coordinator") continue;

        // Determine a sensor type from the Z2M device definition.
        const def_model = dev.definition?.model || "";
        const def_desc = (dev.definition?.description || "").toLowerCase();
        let sensor_type = "unknown";
        if (def_desc.includes("motion")) sensor_type = "motion";
        else if (def_desc.includes("contact") || def_desc.includes("door") || def_desc.includes("window")) sensor_type = "contact";
        else if (def_desc.includes("button") || def_desc.includes("switch") || def_desc.includes("remote")) sensor_type = "switch";
        else if (def_desc.includes("presence") || def_desc.includes("occupancy")) sensor_type = "presence";
        else if (def_desc.includes("temperature") || def_desc.includes("humidity")) sensor_type = "temperature";
        else if (def_desc.includes("leak") || def_desc.includes("water")) sensor_type = "leak";

        upsertDevice({
          ieee_address: dev.ieee_address,
          friendly_name: dev.friendly_name || dev.ieee_address,
          type: sensor_type,
          model: def_model,
          description: dev.definition?.description || "",
          manufacturer: dev.definition?.vendor || "",
          power_source: dev.power_source || "",
        });
      }
      console.log(`✅ Devices synced from Z2M: ${device_list.filter(d => d.type !== "Coordinator").length} device(s)`);
    } catch (err) {
      console.log("⚠️ Failed to sync Z2M device list:", err.message);
    }
  }

  if (topic === "zigbee2mqtt/bridge/response/device/remove") {
    const payload = JSON.parse(data);

    console.log("DEVICE REMOVE RESPONSE:", payload);

    if (payload.status === "ok") {
      const ieee = payload.data.id;

      // GUARD: Z2M RETAINS this remove confirmation and re-publishes it on
      // every broker reconnect / restart. Only act on removes THIS session
      // actually initiated (ieee present in pendingDeletes). Stale retained
      // confirmations — pendingDeletes is empty after a restart — are ignored,
      // so they can never churn the yaml or knock a mapped device offline.
      if (!pendingDeletes.has(ieee)) {
        console.log("ℹ️ Ignoring stale/retained device remove for:", ieee);
        return;
      }

      // devices.json already cleaned up in the DELETE route.
      // Clean up the zigbee2mqtt yaml config for this device.
      try {
        const config = yaml.load(fs.readFileSync(CONFIG_PATH, "utf8"));
        if (config.devices?.[ieee]) {
          delete config.devices[ieee];
          fs.writeFileSync(CONFIG_PATH, yaml.dump(config));
          console.log("✅ Removed from Z2M yaml config:", ieee);
        }
      } catch (err) {
        console.error("⚠️ Failed to clean yaml config:", err.message);
      }

      pendingDeletes.delete(ieee);
      console.log("✅ Z2M removal confirmed for:", ieee);
    }
  }
  console.log(topic, data);

  const io = getIO();

  if (io) {
    io.emit("zigbee-log", {
      topic,
      message: data,
      timestamp: Date.now(),
    });
  }
});
export default client;
MQTTCLIENTEOF

# Patch 3: cameraDiscovery.js — auto-detect interface + nmap fallback + expanded OUI
# The GitHub version hardcodes --interface=eth0 (wrong for WiFi-connected Pi)
# and only knows one OUI. This version auto-detects the correct interface for
# each subnet and falls back to nmap if arp-scan is missing or finds nothing.
cat > "${DASHBOARD_DIR}/backend/services/cameraDiscovery.js" << 'CAMDISCEOF'
import { exec } from "child_process";
import os from "os";

// Subnets to sweep for cameras. The Pi sits on 192.168.50.x, but CP Plus cameras
// can ship on 192.168.1.x, so we scan both (the Pi has an address on each).
const SCAN_SUBNETS =
  process.env.CAMERA_SCAN_SUBNETS || "192.168.1.0/24 192.168.50.0/24";

// MAC vendor prefixes (OUI) that identify our cameras. `f8:20:97` is the CP Plus
// vendor seen on these units. Add other makes via env (comma-separated) if needed.
// Common CP Plus / Dahua OUIs: f8:20:97, 3c:ef:8c, a0:bd:1d, 40:2c:76, 90:02:a9
const CAMERA_OUIS = (
  process.env.CAMERA_OUIS || "f8:20:97,3c:ef:8c,a0:bd:1d,40:2c:76,90:02:a9"
)
  .toLowerCase()
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Auto-detect the best network interface for scanning a given subnet.
 * Returns the interface name whose IPv4 address falls in the same /24 as the
 * target range, or null if none matches (in which case we let the tool pick).
 */
const detect_interface = (range) => {
  // Extract the first 3 octets from the range (e.g. "192.168.50" from "192.168.50.0/24")
  const prefix = range.replace(/\.\d+\/\d+$/, "");
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const info of addrs || []) {
      if (info.family === "IPv4" && !info.internal && info.address.startsWith(prefix + ".")) {
        return name;
      }
    }
  }
  return null;
};

/**
 * Get all active, non-loopback network interface names.
 */
const get_active_interfaces = () => {
  const ifaces = os.networkInterfaces();
  const result = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const info of addrs || []) {
      if (info.family === "IPv4" && !info.internal) {
        result.push(name);
        break;
      }
    }
  }
  return result;
};

// ARP-scan a range -> [{ ip, mac }] for everything that answers.
const arp_scan = (range, iface) =>
  new Promise((resolve) => {
    const iface_arg = iface ? `--interface=${iface} ` : "";
    exec(
      `sudo arp-scan ${iface_arg}${range}`,
      { timeout: 30000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        const rows = [];
        for (const line of (stdout || "").split("\n")) {
          // Lines look like:  192.168.50.100  f8:20:97:37:b5:11  (Unknown)
          const m = line.match(/^(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f:]{17})/i);
          if (m) rows.push({ ip: m[1], mac: m[2].toLowerCase() });
        }
        resolve(rows);
      },
    );
  });

// Fallback: nmap ping-scan + MAC extraction. Works without arp-scan and does
// not need a specific interface — it scans the routing table automatically.
const nmap_scan = (range) =>
  new Promise((resolve) => {
    exec(
      `sudo nmap -sn ${range}`,
      { timeout: 60000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        const rows = [];
        const lines = (stdout || "").split("\n");
        let current_ip = null;
        for (const line of lines) {
          const ip_match = line.match(/Nmap scan report for (\d+\.\d+\.\d+\.\d+)/);
          if (ip_match) {
            current_ip = ip_match[1];
          }
          const mac_match = line.match(/MAC Address:\s+([0-9A-F:]{17})/i);
          if (mac_match && current_ip) {
            rows.push({ ip: current_ip, mac: mac_match[1].toLowerCase() });
            current_ip = null;
          }
        }
        resolve(rows);
      },
    );
  });

// Check if arp-scan is available.
const has_arp_scan = () =>
  new Promise((resolve) => {
    exec("which arp-scan", (error) => resolve(!error));
  });

// Find cameras by MAC vendor across the scanned subnets.
export const discover_cameras = async () => {
  const seen = new Map(); // ip -> mac
  const use_arp_scan = await has_arp_scan();

  for (const range of SCAN_SUBNETS.split(/\s+/).filter(Boolean)) {
    let rows = [];
    if (use_arp_scan) {
      // Auto-detect the correct interface for this subnet
      const iface = detect_interface(range);
      if (iface) {
        console.log(`🔍 Camera scan: arp-scan ${range} on ${iface}`);
        rows = await arp_scan(range, iface);
      } else {
        // No interface matches this subnet — try all active interfaces
        const active = get_active_interfaces();
        for (const if_name of active) {
          console.log(`🔍 Camera scan: arp-scan ${range} on ${if_name} (fallback)`);
          const r = await arp_scan(range, if_name);
          rows.push(...r);
        }
      }
    }

    // Fallback to nmap if arp-scan isn't installed or found nothing
    if (rows.length === 0) {
      console.log(`🔍 Camera scan: nmap -sn ${range} (fallback)`);
      rows = await nmap_scan(range);
    }

    for (const r of rows) seen.set(r.ip, r.mac);
  }

  const cameras = [];
  for (const [ip, mac] of seen) {
    const oui = mac.slice(0, 8); // e.g. "f8:20:97"
    if (CAMERA_OUIS.includes(oui)) cameras.push({ ip, mac });
  }

  // If no cameras found by OUI, log what we did find for debugging
  if (cameras.length === 0 && seen.size > 0) {
    console.log(
      "📷 Camera scan: no OUI match. Hosts found:",
      [...seen.entries()].map(([ip, mac]) => `${ip} (${mac})`).join(", "),
    );
    console.log("📷 Looking for OUIs:", CAMERA_OUIS.join(", "));
  }

  return cameras;
};
CAMDISCEOF

# Patch 4: Rename discoverCameras import to match snake_case export
grep -rl "discoverCameras" "${DASHBOARD_DIR}/backend/" --include="*.js" 2>/dev/null | xargs sed -i 's/discoverCameras/discover_cameras/g' 2>/dev/null || true

echo "  Code patches applied (mqttClient.js, cameraDiscovery.js, deviceStore.js)"

# Create data directory (devices.json + hub-config.json live OUTSIDE the repo)
mkdir -p "${DATA_DIR}"
if [ ! -f "${DATA_DIR}/devices.json" ]; then
    echo "[]" > "${DATA_DIR}/devices.json"
    echo "  Created ${DATA_DIR}/devices.json"
fi
# Remove old hub config so the setup modal shows on first login
if [ -f "${DATA_DIR}/hub-config.json" ]; then
    rm "${DATA_DIR}/hub-config.json"
    echo "  Removed old hub-config.json (setup modal will appear after login)"
fi

# Install backend dependencies
echo "  Installing backend dependencies..."
cd "${DASHBOARD_DIR}/backend"
rm -rf node_modules 2>/dev/null || true
npm install
echo "  Backend dependencies installed"

# Create backend .env
cat > "${DASHBOARD_DIR}/backend/.env" << ENVEOF
REMOTE_BACKEND_URL=${EC2_BACKEND}
HUB_SECRET_KEY=${HUB_SECRET}
ENVEOF
echo "  Created backend .env"

# Install frontend dependencies and build
echo "  Installing frontend dependencies..."
cd "${DASHBOARD_DIR}/frontend"
rm -rf node_modules 2>/dev/null || true
npm install
echo "  Building React frontend (this may take a minute on Pi)..."
npm run build
echo "  Frontend built → ${DASHBOARD_DIR}/frontend/dist/"

# Start with PM2
pm2 delete pi-dashboard 2>/dev/null || true
cd "${DASHBOARD_DIR}/backend"
pm2 start server.js --name pi-dashboard --cwd "${DASHBOARD_DIR}/backend"
echo "  Pi Dashboard started on port 4000"
echo "  Flow: Login → Hub Setup → Devices dashboard"
echo "  Hub heartbeat: every 30s -> ${EC2_BACKEND}/api/hub/heartbeat"

# Start MQTT bridge from repo (if mqtt.js exists in backend/)
if [ -f "${DASHBOARD_DIR}/backend/mqtt.js" ]; then
    pm2 delete repo-mqtt 2>/dev/null || true
    pm2 start mqtt.js --name repo-mqtt --cwd "${DASHBOARD_DIR}/backend"
    echo "  Repo MQTT bridge started"
fi

# Clean up any leftover standalone hub-heartbeat service from older setups.
pm2 delete hub-heartbeat 2>/dev/null || true
rm -rf "${PI_HOME}/hub-heartbeat" 2>/dev/null || true


# ================================================================
# 8. AUTOSSH REVERSE TUNNEL (Camera Pi → EC2)
# ================================================================
# NOTE: For production with Cloudflare, the named tunnel p1.awesomliving.com
# pointing to http://localhost:1984 replaces this autossh approach entirely.
# Cloudflare Tunnel provides authenticated, encrypted access without needing
# SSH keys or open ports on EC2. To switch:
#   1. Install cloudflared on the Pi
#   2. Authenticate: cloudflared tunnel login
#   3. Create tunnel: cloudflared tunnel create p1
#   4. Route DNS: cloudflared tunnel route dns p1 p1.awesomliving.com
#   5. Run: cloudflared tunnel run p1 --url http://localhost:1984
#   6. Disable autossh: sudo systemctl disable camera-tunnel
# The autossh tunnel below is the current deployment method.
echo ""
echo "[8/9] Setting up autossh reverse tunnel to EC2..."

SSH_KEY="${PI_HOME}/.ssh/ec2_tunnel"

# Generate SSH key if it doesn't exist
if [ ! -f "$SSH_KEY" ]; then
    echo "  Generating SSH key for EC2 tunnel..."
    mkdir -p "${PI_HOME}/.ssh"
    ssh-keygen -t ed25519 -f "$SSH_KEY" -N "" -C "pi@raspberrypi"
    echo ""
    echo "  ┌──────────────────────────────────────────────────────────┐"
    echo "  │ IMPORTANT: Add this public key to EC2 authorized_keys:  │"
    echo "  └──────────────────────────────────────────────────────────┘"
    echo ""
    cat "${SSH_KEY}.pub"
    echo ""
    echo "  Run on EC2:"
    echo "    echo '$(cat ${SSH_KEY}.pub)' >> ~/.ssh/authorized_keys"
    echo ""
fi

# Systemd service for autossh reverse tunnel
# Tunnels local go2rtc (port 1984) to EC2 localhost:1984
# EC2's nginx then proxies 8080 → localhost:1984 for public access
sudo tee /etc/systemd/system/camera-tunnel.service > /dev/null << TUNNELEOF
[Unit]
Description=Autossh reverse tunnel for camera stream to EC2
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${PI_USER}
Environment=AUTOSSH_GATETIME=0
ExecStart=/usr/bin/autossh -M 0 -N \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    -o StrictHostKeyChecking=no \
    -o ExitOnForwardFailure=yes \
    -i ${SSH_KEY} \
    -R 127.0.0.1:1984:127.0.0.1:1984 \
    ${EC2_USER}@${EC2_IP}
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
TUNNELEOF

sudo systemctl daemon-reload
sudo systemctl enable camera-tunnel

# Only start if key exists and has been deployed
if [ -f "$SSH_KEY" ]; then
    sudo systemctl start camera-tunnel 2>/dev/null || true
    echo "  Camera tunnel service started (Pi:1984 → EC2:1984)"
else
    echo "  WARNING: SSH key not found. Tunnel not started."
fi


# ================================================================
# 9. FINAL SETUP — Boot Persistence
# ================================================================
echo ""
echo "[9/9] Final setup — ensuring everything auto-starts on boot..."

# ── PM2 auto-restart on boot ──────────────────────────────────────
# CRITICAL: pm2 startup MUST run unconditionally (not just on first install).
# This creates the systemd service that resurrects all PM2 processes on reboot.
# Without this, a Pi power cycle leaves pm2 dead with zero processes.
echo "  Configuring PM2 startup hook (systemd)..."
# The startup command prints a sudo command that needs to be eval'd
PM2_STARTUP_CMD=$(pm2 startup systemd -u ${PI_USER} --hp ${PI_HOME} 2>/dev/null | grep "sudo" | head -1)
if [ -n "$PM2_STARTUP_CMD" ]; then
    echo "  Running: $PM2_STARTUP_CMD"
    eval "$PM2_STARTUP_CMD" 2>/dev/null || true
else
    # Fallback: run the startup command directly (works on most Pi setups)
    sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u ${PI_USER} --hp ${PI_HOME} 2>/dev/null || true
fi

# Verify pm2 systemd service exists and is enabled
if systemctl is-enabled pm2-${PI_USER} &>/dev/null; then
    echo "  PM2 systemd service (pm2-${PI_USER}) is ENABLED"
else
    echo "  PM2 systemd service not found — creating manually..."
    sudo tee /etc/systemd/system/pm2-${PI_USER}.service > /dev/null << PM2SVCEOF
[Unit]
Description=PM2 process manager for ${PI_USER}
Documentation=https://pm2.keymetrics.io/
After=network.target

[Service]
Type=forking
User=${PI_USER}
LimitNOFILE=infinity
LimitNPROC=infinity
LimitCORE=infinity
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/lib/nodejs/bin
Environment=PM2_HOME=${PI_HOME}/.pm2
PIDFile=${PI_HOME}/.pm2/pm2.pid
Restart=on-failure

ExecStart=/usr/lib/node_modules/pm2/bin/pm2 resurrect
ExecReload=/usr/lib/node_modules/pm2/bin/pm2 reload all
ExecStop=/usr/lib/node_modules/pm2/bin/pm2 kill

[Install]
WantedBy=multi-user.target
PM2SVCEOF
    sudo systemctl daemon-reload
    sudo systemctl enable pm2-${PI_USER}
    echo "  PM2 systemd service created and enabled manually"
fi

# Save ALL current PM2 processes — this is what pm2 resurrect reads on boot
echo "  Saving PM2 process list for boot resurrection..."
pm2 save

# ── Backup: @reboot cron for PM2 (belt-and-suspenders) ───────────
# In case the systemd hook fails for any reason, a cron @reboot ensures
# pm2 resurrect runs. This is harmless if systemd already started it.
(crontab -l 2>/dev/null | grep -v "pm2 resurrect" ; echo "@reboot sleep 10 && /usr/local/bin/pm2 resurrect --no-daemon 2>&1 | logger -t pm2-reboot") | crontab -
echo "  @reboot cron fallback for PM2 added"

# ── Verify all systemd services are enabled ───────────────────────
echo "  Verifying all services are enabled for boot..."
SERVICES_TO_CHECK="go2rtc mosquitto glk-bridge camera-tunnel"
# zigbee2mqtt is conditional on dongle, but should still be enabled
if systemctl list-unit-files | grep -q zigbee2mqtt; then
    SERVICES_TO_CHECK="$SERVICES_TO_CHECK zigbee2mqtt"
fi
for svc in $SERVICES_TO_CHECK; do
    if systemctl is-enabled "$svc" &>/dev/null; then
        echo "    $svc — enabled"
    else
        sudo systemctl enable "$svc" 2>/dev/null || true
        echo "    $svc — just enabled"
    fi
done

# Restore swap to normal
if [ -f /etc/dphys-swapfile ]; then
    sudo sed -i 's/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=100/' /etc/dphys-swapfile
    sudo systemctl restart dphys-swapfile
fi

# Disable set -e for the status summary — service checks return non-zero
# for inactive services and that should NOT make the script exit with an error.
set +e

echo ""
echo "============================================"
echo "  Awesom Living Pi Setup Complete! (v5)"
echo "============================================"
echo ""
echo "  Pi IP:          ${PI_IP}"
echo "  Cameras:        ${#CAMERAS[@]} configured"
for entry in "${CAMERAS[@]}"; do
  IFS='|' read -r _name _ip _user _pass <<< "$entry"
  echo "    - ${_name} @ ${_ip}"
done
echo "  Backend:        ${EC2_BACKEND}"
echo ""
echo "  Services:"
DASH_STATUS=$(pm2 show pi-dashboard 2>/dev/null | grep -oP 'status.*│\s*\K\w+' || echo "check pm2")
GO2RTC_STATUS=$(systemctl is-active go2rtc 2>/dev/null || echo "inactive")
Z2M_STATUS=$(systemctl is-active zigbee2mqtt 2>/dev/null || echo "no dongle")
MOSQ_STATUS=$(systemctl is-active mosquitto 2>/dev/null || echo "inactive")
GLK_STATUS=$(systemctl is-active glk-bridge 2>/dev/null || echo "inactive")
TUNNEL_STATUS=$(systemctl is-active camera-tunnel 2>/dev/null || echo "check SSH key")
echo "    Pi Dashboard:  http://${PI_IP}:4000  (${DASH_STATUS})"
echo "    go2rtc:        http://${PI_IP}:1984  (${GO2RTC_STATUS})"
echo "    Zigbee2MQTT:   http://${PI_IP}:8080  (${Z2M_STATUS})"
echo "    Mosquitto:     localhost:1883         (${MOSQ_STATUS})"
echo "    GLK bridge:    localhost:8766         (${GLK_STATUS})"
echo "    Hub heartbeat: every 30s -> backend   (via Pi Dashboard server.js)"
echo "    Camera tunnel:                        (${TUNNEL_STATUS})"
echo ""
echo "  PM2 processes (will auto-restart on reboot):"
pm2 list 2>/dev/null || true
PM2_SVC_STATUS=$(systemctl is-enabled pm2-${PI_USER} 2>/dev/null || echo "not found")
echo "  PM2 boot service (pm2-${PI_USER}): ${PM2_SVC_STATUS}"
echo ""
echo "  Public camera URL (via EC2):"
echo "    http://${EC2_IP}:8080"
echo "  Production Cloudflare tunnel (when provisioned):"
echo "    https://p1.awesomliving.com"
echo ""
echo "  Quick commands:"
echo "    Check tunnel:     sudo systemctl status camera-tunnel"
echo "    Check go2rtc:     curl http://localhost:1984/api/streams"
for entry in "${CAMERAS[@]}"; do
  IFS='|' read -r _name _ip _user _pass <<< "$entry"
  echo "    Test ${_name}:   curl -s -o /dev/null -w '%{http_code}' http://localhost:1984/api/frame.jpeg?src=${_name}"
done
echo "    View MQTT logs:   pm2 logs mqtt-bridge"
echo "    View GLK logs:    sudo journalctl -u glk-bridge -f"
echo "    View Dashboard:   pm2 logs pi-dashboard"
echo "    View HB logs:     pm2 logs pi-dashboard | grep heartbeat"
echo "    Camera health:    curl http://localhost:3002/health"
echo "    Zigbee2MQTT UI:   http://${PI_IP}:8080"
echo "    Check PM2 boot:   systemctl is-enabled pm2-${PI_USER}"
echo ""
echo "  Remote shutdown (from app):"
echo "    The mobile app can shut down or reboot this Pi safely."
echo "    POST /api/hub/command → {home_id, command:'shutdown'|'reboot'}"
echo "    Pi picks up the command on its next heartbeat (~15s)."
echo ""
echo "  Update dashboard later:"
echo "    cd ${REPO_DIR} && git pull"
echo "    cd frontend && npm install && npm run build"
echo "    pm2 restart pi-dashboard"
echo ""
echo "  Flow: Login → Hub Setup (first time) → Devices dashboard"
echo "============================================"

# Explicit success exit — prevents wrapper scripts from reporting false failures
exit 0
