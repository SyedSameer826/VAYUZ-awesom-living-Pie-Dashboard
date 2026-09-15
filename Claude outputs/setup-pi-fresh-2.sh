#!/usr/bin/env bash
# ============================================================================
# setup-pi-fresh.sh — Complete Raspberry Pi Setup for Awesom Living
# ============================================================================
# Brings a fresh Pi (Raspberry Pi OS, SSH enabled) to full state.
# Supports both PRODUCTION and QA environments — prompts at start.
#
# What this installs:
#   1. camera-wrapper   — Express proxy for go2rtc REST API (port 3002)
#   2. go2rtc           — RTSP → WebRTC/HLS transcoder (port 1984)
#   3. Mosquitto        — MQTT broker (port 1883)
#   4. Zigbee2MQTT      — Zigbee coordinator (port 8080 UI)
#   5. MQTT bridge      — Forwards Zigbee events to cloud backend
#   6. GLK bridge       — TCP listener for GLK Sleep Monitor (port 8766)
#   7. Pi Dashboard     — Local dashboard + API server (port 4000)
#   8. Cloudflare tunnel— Named tunnel for camera streaming
#   9. Boot persistence — PM2 startup, cron backup, systemd services
#
# Network: 192.168.50.x subnet (pilot home)
# EC2:     13.127.250.78 (Mumbai) / awesomliving.com | qa.awesomliving.com
# Cameras: Multiple CP Plus cameras (see CAMERAS array below)
#
# Usage:
#   chmod +x setup-pi-fresh.sh
#   ./setup-pi-fresh.sh
#
# Updated: 2026-09-15 v26 — STATIC IP CONFIGURATION:
#   setup-pi-fresh.sh — static IP (192.168.50.106) is now configured inside
#     the setup script itself, so every fresh Pi automatically gets the correct
#     IP without relying on deploy-pi.ps1's external set-static-ip.sh.
#     Supports both dhcpcd (Bullseye) and NetworkManager (Bookworm+).
#     Does NOT restart networking — IP takes effect on reboot.
#
# Updated: 2026-09-13 v25 — ZIGBEE TYPE AUTO-DETECTION FIX:
#   mqttClient.js — fixed type detection for freshly-paired devices:
#     - ROOT CAUSE: handle_bridge_devices only checked dev.definition.description
#       for type keywords. After a coordinator reset, description is empty until
#       Z2M finishes interviewing the device, so all sensors got "zigbee" type.
#     - FIX: now also checks dev.definition.exposes array — exposes is populated
#       even before interview completes. occupancy→"motion", contact→"contact",
#       action→"switch", presence→"presence". Also handles temperature/humidity
#       and leak/water sensor types.
#     - handle_bridge_devices now upserts ALL non-Coordinator devices (not just
#       new ones), so type gets refreshed on every Z2M restart.
#   DeviceForm.jsx — added "Temperature", "Leak", and "Zigbee" options to the
#     type dropdown so auto-detected types are always selectable.
#   index.jsx — also clears type to empty if falsy (not just "unknown").
#   Inline MQTT handler — changed device_joined/interview defaults from
#     "unknown" to "zigbee"; upsertDevice fallback also "zigbee".
#
# Updated: 2026-09-02 v23 — CLOUDFLARE INGRESS FIX + AUTO-RETRY + HEALTH CHECKS:
#   Cloudflare tunnel — ingress rules fix (critical):
#     - ROOT CAUSE: token-based cloudflared sometimes fails to pull ingress
#       config from Cloudflare dashboard, causing "No ingress rules" + HTTP 503.
#     - FIX: setup now creates /etc/cloudflared/config.yml with explicit ingress
#       rules (TUNNEL_HOSTNAME → localhost:1984) after service install.
#     - Post-start log check: if "No ingress rules" warning detected, auto-restarts.
#     - Works for both prod (p1.awesomliving.com) and QA (hub1-qa.awesomliving.com).
#   Auto-retry for all critical operations:
#     - New retry() function: retries up to 6 times with exponential backoff
#       (5s, 10s, 20s, 40s, 60s, 60s) for network-dependent commands.
#     - Applied to: apt-get, Node.js install, all npm install, git clone/pull,
#       cloudflared download, pm2 global install.
#   Service health checks after every service start:
#     - New check_service_health(): verifies systemd services are active after
#       start, auto-restarts up to 3 times if not (go2rtc, mosquitto, glk-bridge,
#       cloudflared).
#     - New check_pm2_health(): verifies PM2 processes come online, auto-restarts
#       if stuck (camera-wrapper, mqtt-bridge, pi-dashboard).
#   Prod tunnel token now hardcoded (carried over from earlier v23):
#     - Both environments fully automatic: `./setup-pi-fresh.sh --prod` or `--qa`.
#   Version strings updated throughout (pre-flight banner, completion banner).
#
# Updated: 2026-09-01 v22 — ZIGBEE DEVICE AUTO-DISCOVERY + TYPE INFERENCE:
#   mqttClient.js (Pi Dashboard) — complete rewrite of Zigbee device sync:
#     - NEW: detect_zigbee_type(payload) — infers sensor type from MQTT payload
#       keys (contact→"contact", occupancy→"motion", presence→"presence",
#       action→"button", fallback→"zigbee"). Catches devices even when Z2M
#       definition is missing.
#     - NEW: handle_bridge_devices(raw) — processes zigbee2mqtt/bridge/devices
#       topic (published at Z2M startup + device join/leave). Adds every
#       non-Coordinator device to devices.json as unmapped, with type inferred
#       from Z2M definition description.
#     - NEW: handle_device_message(ieee, raw) — processes individual device
#       messages on zigbee2mqtt/0x<ieee> topics. Catches devices that were
#       missed by bridge/devices (e.g. sensors that were already paired but
#       not in devices.json after a fresh setup).
#     - ROOT CAUSE: v21's mqttClient.js in the repo never called upsertDevice()
#       for individual device messages — Zigbee sensors appeared in pairing
#       logs but never showed up as unmapped in the Device Listing page.
#     - Both handlers import getDevices to check for existing devices before
#       upserting, preventing duplicate entries.
#   Version strings updated throughout (pre-flight banner, completion banner).
#
# Updated: 2026-09-01 v21 — DEPLOY SCRIPT: SSH FALLBACK + GATEWAY FIX:
#   Windows deploy-pi.ps1 (v5):
#     - Gateway exclusion: 192.168.50.1 excluded (Cudy router's Broadcom MAC
#       was misidentified as "Raspberry Pi" by nmap)
#     - SSH validation: nmap candidates verified with plink before use
#     - SSH fallback: when nmap vendor match fails, tries SSH on alive hosts,
#       then sweeps DHCP range 100-199
#     - Manual IP entry: if all auto-detection fails, user can type the IP
#       from the Cudy DHCP client list
#     - 10 scan attempts (up from 6) for slow first boot
#     - All PowerShell 5.1 compatible (no PS7-only syntax)
#   Mac deploy-pi.command (v6):
#     - Gateway exclusion added to candidate filter
#
# Updated: 2026-08-31 v20 — GLK VITALS COMPLETENESS + EMERGENCY FORWARDING:
#   GLK bridge — store ALL 13 raw device fields:
#     - Added signal_quality (p[9]) to parse_realtime — was extracted but not
#       returned, so backend never received it. Critical for device health
#       monitoring and "signal weak" alerts.
#     - All 13 fields now forwarded: heart_rate, respiration_rate, status_code,
#       status, in_bed, out_of_bed, snoring, apnea_suspected, life_abnormality,
#       body_movement, battery_level, signal_quality, timer_counter.
#   GLK bridge — emergency (0x0D) improved:
#     - Emergency frames now forward decoded fields (life_abnormality=true,
#       status_code=5) instead of raw hex, so backend can process them the
#       same as regular vitals and trigger push notifications immediately.
#   Standalone glk/ files synced with inline versions.
#   Version strings updated throughout (pre-flight banner, completion banner).
#
# Updated: 2026-08-20 v4 — MQTT BRIDGE DOTENV FIX + FRONTEND AUTH FIX:
#   MQTT bridge fix (400 errors / wrong backend):
#     - dotenv added to package.json dependencies
#     - mqtt.js now imports dotenv and calls dotenv.config() BEFORE reading
#       process.env.BACKEND_URL — root cause of bridge always hitting production
#     - PM2 start passes BACKEND_URL and SECRET_KEY inline as belt-and-suspenders
#     - Error logging now includes HTTP status and response body for debugging
#   Frontend auth.js fix (401 Unauthorized / token mismatch):
#     - auth.js ALWAYS patched to read VITE_BACKEND_URL (safe for both envs)
#     - Frontend .env created for BOTH prod and QA (was QA-only before)
#     - This fixes: login gets prod token → Pi forwards to QA → 401
#   Environment selector improvements:
#     - Supports DEPLOY_ENV env variable (for plink/SSH: DEPLOY_ENV=qa)
#     - Supports ~/deploy-env config file (persists across runs)
#     - Saves chosen env to ~/deploy-env so future runs remember it
#     - Prominent warning box when no flag and no TTY
#
# Updated: 2026-08-21 v9 — GLK BLE TRANSPORT FIX:
#   GLK provisioning was failing (wifi_ack=false, 502) because the BLE write used
#   response=True which the GLK fff1 characteristic doesn't support. The failed
#   write + retry corrupted device state. Fix:
#     - BLE writes now use response=False only (matches device capability)
#     - 0.12s inter-chunk delay (matches repo's tested timing)
#     - Subscribe/unsubscribe per config step (clean notification cycle)
#     - Verbose stderr debugging preserved for journalctl troubleshooting
#
# Updated: 2026-08-21 v8 — GLK PAIRING FIX + HARDCODE TUNNEL TOKEN + REMOVE CAMERAS:
#   GLK pairing 502 fix (BLE provisioning failed):
#     - ROOT CAUSE: server.js reads glk_provision.py from $DASHBOARD_DIR/backend/glk/
#       but setup script only deployed the improved version to $PI_HOME/glk-bridge/
#     - FIX: After deploying to glk-bridge/, ALSO copy the improved glk_protocol.py
#       and glk_provision.py into $DASHBOARD_DIR/backend/glk/ so server.js uses them
#   Cameras removed from CAMERAS array (paired via Pi Dashboard UI only)
#   Cloudflare tunnel token hardcoded for QA environment (zero manual commands)
#
# Updated: 2026-08-21 v5 — CLOUDFLARE NAMED TUNNEL:
#   Replaced autossh reverse SSH tunnel (section 8) with Cloudflare named tunnel:
#     - Installs cloudflared (arm64/arm .deb)
#     - Token-based auth (no interactive browser login)
#     - Registers tunnel URL with server.js via POST /api/hub/tunnel
#     - Disables legacy camera-tunnel (autossh) if present
#     - Token passed via CF_TUNNEL_TOKEN env var or ~/.cloudflare-tunnel-token file
#
# Updated: 2026-08-20 v4 — ASSIGN-NAME FIX:
#   server.js assign-name crash fix:
#     - Z2M configuration.yaml may have no "devices:" key on fresh installs
#     - Original code crashes with TypeError: Cannot read properties of undefined
#     - Patched: try/catch + null check for config.devices — skips rename if
#       device not in Z2M config, still forwards to remote backend
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
#   Device-to-home mapping:
#     - server.js patched: assign-name, assign-camera, glk/pair endpoints
#       now include home: readHubConfig().home_id in remote backend POST
#       payloads, linking each device to the Pi's configured home
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

# ── Retry function — auto-retry critical operations up to 6 times ────────
# Usage: retry <description> <command...>
# Example: retry "apt-get update" sudo apt-get update -qq
#
# Retries up to 6 times with exponential backoff (5s, 10s, 20s, 40s, 60s, 60s).
# On each failure, logs the attempt number and waits before retrying.
# If all 6 attempts fail, prints an error and exits with code 1.
retry() {
    local description="$1"
    shift
    local max_attempts=6
    local attempt=1
    local delays=(5 10 20 40 60 60)

    while [ $attempt -le $max_attempts ]; do
        if "$@"; then
            if [ $attempt -gt 1 ]; then
                echo "  ✓ ${description} succeeded on attempt ${attempt}/${max_attempts}"
            fi
            return 0
        fi

        if [ $attempt -eq $max_attempts ]; then
            echo "  ✗ ${description} FAILED after ${max_attempts} attempts"
            return 1
        fi

        local delay=${delays[$((attempt - 1))]}
        echo "  ⚠ ${description} failed (attempt ${attempt}/${max_attempts}) — retrying in ${delay}s..."
        sleep "$delay"
        attempt=$((attempt + 1))
    done
}

# ── Service health check — verify service is running, auto-restart if not ─
# Usage: check_service_health <service_name> [max_retries]
# Checks if a systemd service is active. If not, attempts to restart it
# up to max_retries times (default 3) with 10s waits between attempts.
check_service_health() {
    local service_name="$1"
    local max_retries="${2:-3}"
    local attempt=1

    while [ $attempt -le $max_retries ]; do
        if systemctl is-active --quiet "$service_name" 2>/dev/null; then
            echo "  ✓ ${service_name} is running"
            return 0
        fi

        echo "  ⚠ ${service_name} not active (attempt ${attempt}/${max_retries}) — restarting..."
        sudo systemctl restart "$service_name" 2>/dev/null || true
        sleep 10
        attempt=$((attempt + 1))
    done

    echo "  ✗ ${service_name} failed to start after ${max_retries} attempts"
    echo "    Check logs: sudo journalctl -u ${service_name} --no-pager -n 50"
    return 1
}

# ── PM2 process health check — verify PM2 process is online, auto-restart ─
# Usage: check_pm2_health <process_name> [max_retries]
check_pm2_health() {
    local process_name="$1"
    local max_retries="${2:-3}"
    local attempt=1

    while [ $attempt -le $max_retries ]; do
        local status
        status=$(pm2 show "$process_name" 2>/dev/null | grep -oP 'status\s*│\s*\K\w+' || echo "stopped")
        if [ "$status" = "online" ]; then
            echo "  ✓ PM2: ${process_name} is online"
            return 0
        fi

        echo "  ⚠ PM2: ${process_name} status=${status} (attempt ${attempt}/${max_retries}) — restarting..."
        pm2 restart "$process_name" 2>/dev/null || true
        sleep 5
        attempt=$((attempt + 1))
    done

    echo "  ✗ PM2: ${process_name} failed to come online after ${max_retries} attempts"
    echo "    Check logs: pm2 logs ${process_name} --lines 50"
    return 1
}

# ── Environment selector ─────────────────────────────────────────────────
# Priority order:
#   1. CLI flag:        ./setup-pi-fresh.sh --qa   (or --prod)
#   2. Env variable:    DEPLOY_ENV=qa ./setup-pi-fresh.sh
#   3. Config file:     echo "qa" > ~/deploy-env   (persists across runs)
#   4. Interactive:     prompt (if terminal is available)
#   5. Fallback:        PRODUCTION (when piped via plink/SSH with no flag)
#
# For plink/SSH usage (no TTY), pass the flag:
#   plink ... "bash -s -- --qa" < setup-pi-fresh.sh

# Check CLI flags first
if [ "${1}" = "--qa" ]; then
  DEPLOY_ENV="qa"
elif [ "${1}" = "--prod" ]; then
  DEPLOY_ENV="prod"
fi

# If not set by CLI, check for pre-set environment variable
# (allows: DEPLOY_ENV=qa plink ... "bash -s" < setup-pi-fresh.sh)
# DEPLOY_ENV may already be set from the calling environment — keep it.

# If still not set, check for a persistent config file
if [ -z "$DEPLOY_ENV" ]; then
  DEPLOY_ENV_FILE="${HOME}/deploy-env"
  if [ -f "$DEPLOY_ENV_FILE" ]; then
    FILE_ENV=$(cat "$DEPLOY_ENV_FILE" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
    if [ "$FILE_ENV" = "qa" ] || [ "$FILE_ENV" = "prod" ]; then
      DEPLOY_ENV="$FILE_ENV"
      echo "  Environment from ~/deploy-env: ${DEPLOY_ENV}"
    fi
  fi
fi

if [ -z "$DEPLOY_ENV" ]; then
  # When run via plink/ssh pipe (stdin consumed by 'cat'), there is no tty
  # and 'read' would get EOF → exit 1 under set -e, killing the script.
  if [ -t 0 ]; then
    echo ""
    echo "============================================"
    echo "  Select Environment"
    echo "============================================"
    echo "  1) Production  (awesomliving.com)"
    echo "  2) QA          (qa.awesomliving.com)"
    echo ""
    read -rp "  Enter 1 or 2: " ENV_CHOICE
    case "$ENV_CHOICE" in
      2|qa|QA)   DEPLOY_ENV="qa" ;;
      *)         DEPLOY_ENV="prod" ;;
    esac
  else
    echo ""
    echo "  ┌─────────────────────────────────────────────────────────────┐"
    echo "  │  No --qa/--prod flag and no interactive terminal detected.  │"
    echo "  │  Defaulting to PRODUCTION.                                  │"
    echo "  │                                                             │"
    echo "  │  For QA, re-run with:                                       │"
    echo "  │    plink ... \"bash -s -- --qa\" < setup-pi-fresh.sh          │"
    echo "  │  Or create a config file on the Pi first:                   │"
    echo "  │    plink ... \"echo qa > ~/deploy-env\"                       │"
    echo "  └─────────────────────────────────────────────────────────────┘"
    echo ""
    DEPLOY_ENV="prod"
  fi
fi

# Save the chosen environment so future runs remember it
echo "$DEPLOY_ENV" > "${HOME}/deploy-env"

if [ "$DEPLOY_ENV" = "qa" ]; then
  ENV_LABEL="QA"
  EC2_DOMAIN="qa.awesomliving.com"
  ZIGBEE_SECRET="jwt_secret_of_awesomliving_qa"
  HUB_SECRET="jwt_secret_of_awesomliving_qa"
else
  ENV_LABEL="PRODUCTION"
  EC2_DOMAIN="awesomliving.com"
  ZIGBEE_SECRET="jwt_secret_of_awesomliving_app"
  HUB_SECRET="jwt_secret_of_awesomliving_app"
fi

# Branch selection: QA clones 'qa' branch, prod clones 'main' branch
if [ "$DEPLOY_ENV" = "qa" ]; then
    REPO_BRANCH="qa"
else
    REPO_BRANCH="main"
fi

echo ""
echo "  >>> Setting up for: ${ENV_LABEL} (${EC2_DOMAIN}) <<<"
echo ""

# ── Configuration (edit these for a different deployment) ──────────────────

# Camera configuration — one line per camera: STREAM_NAME|IP|USER|PASS
# Add or remove entries as cameras are added to the home.
# If only one camera, this works identically to v2 (single-camera mode).
CAMERAS=(
  # Cameras are paired via Pi Dashboard UI ("Pair Camera" button).
  # No hardcoded entries — each home gets its cameras added dynamically.
  # Example: "cam_50_100|192.168.50.100|admin|Awesom.2026"
)

EC2_IP="13.127.250.78"
EC2_USER="ubuntu"
# EC2_DOMAIN set by environment selector above
EC2_BACKEND="https://${EC2_DOMAIN}"

BACKEND_API_URL="${EC2_BACKEND}/api/device-event"
# ZIGBEE_SECRET and HUB_SECRET set by environment selector above

# Cloudflare Tunnel — token-based authentication (no interactive login needed)
# Token source priority: CF_TUNNEL_TOKEN env var → ~/.cloudflare-tunnel-token file
# Get the token from: Cloudflare Zero Trust → Networks → Tunnels → [tunnel] → Install
# The TUNNEL_HOSTNAME is the public hostname configured in the tunnel's "Public Hostname" tab.
# Both tokens hardcoded — `./setup-pi-fresh.sh --prod` or `--qa` is fully automatic.
# Override with CF_TUNNEL_TOKEN env var if needed.
if [ "$DEPLOY_ENV" = "qa" ]; then
  CLOUDFLARE_TUNNEL_TOKEN="${CF_TUNNEL_TOKEN:-eyJhIjoiNTBiNjRjMjhjOTgwNzVlMzIyODFlODMxNTNmOGZmM2QiLCJ0IjoiYTEwNWU0OTYtYWIyNi00NGYyLThhN2MtZTc4MzM5NjNmZTE1IiwicyI6Ik9EZG1NRFU1T0RFdFltRTRZaTAwTVROa0xXRXhPVGt0TmpCbFptSTJOR1ZsWVdJdyJ9}"
  TUNNEL_HOSTNAME="${CF_TUNNEL_HOST:-hub1-qa.awesomliving.com}"
else
  CLOUDFLARE_TUNNEL_TOKEN="${CF_TUNNEL_TOKEN:-eyJhIjoiNTBiNjRjMjhjOTgwNzVlMzIyODFlODMxNTNmOGZmM2QiLCJ0IjoiYmY2MTNkYzAtMjI3MS00YjE1LWEwMzItNDI1MzhhZDljZTI3IiwicyI6ImE4TWZXcmFLcmsrWUhud2ZIMVRUYW5jbmlLaWRSdWNzVmZVN3NsZkhjaFE9In0=}"
  TUNNEL_HOSTNAME="${CF_TUNNEL_HOST:-p1.awesomliving.com}"
fi

PI_USER="pi"
PI_HOME="/home/${PI_USER}"
REPO_DIR="${PI_HOME}/VAYUZ-awesom-living-Pie-Dashboard"

# Static IP — ensures Pi always gets 192.168.50.106 on eth0
STATIC_IP="192.168.50.106"
STATIC_GATEWAY="192.168.50.1"
STATIC_DNS="8.8.8.8"
STATIC_INTERFACE="eth0"

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
echo "  Awesom Living — Fresh Pi Setup (v26)"
echo "  MODE:      ${ENV_LABEL}"
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

# ── Static IP configuration ──────────────────────────────────────────────
# Ensures the Pi always comes up at 192.168.50.106 on eth0.
# Supports both dhcpcd (Bullseye/older) and NetworkManager (Bookworm+).
# Does NOT restart networking — the new IP takes effect on next reboot.
echo ""
echo "[Static IP] Configuring ${STATIC_INTERFACE} -> ${STATIC_IP}/24 ..."
CURRENT_IP=$(ip -4 addr show "${STATIC_INTERFACE}" 2>/dev/null | awk '/inet /{split($2,a,"/"); print a[1]}' || true)
STATIC_IP_CONFIGURED=false

if [ -f /etc/dhcpcd.conf ]; then
  # ── dhcpcd path (Raspberry Pi OS Bullseye and earlier) ──
  if grep -q "static ip_address=${STATIC_IP}/24" /etc/dhcpcd.conf 2>/dev/null; then
    echo "[Static IP] Already configured in dhcpcd.conf - skipping."
    STATIC_IP_CONFIGURED=true
  else
    # Remove any existing static block for this interface (|| true: no match is fine)
    sudo sed -i "/^interface ${STATIC_INTERFACE}/,/^$/d" /etc/dhcpcd.conf || true
    sudo tee -a /etc/dhcpcd.conf > /dev/null << IPEOF

interface ${STATIC_INTERFACE}
static ip_address=${STATIC_IP}/24
static routers=${STATIC_GATEWAY}
static domain_name_servers=${STATIC_DNS}
IPEOF
    echo "[Static IP] Written to /etc/dhcpcd.conf"
    STATIC_IP_CONFIGURED=true
  fi
elif command -v nmcli &>/dev/null; then
  # ── NetworkManager path (Bookworm+) ──
  NM_CONN=$(nmcli -t -f NAME,DEVICE con show --active 2>/dev/null | grep ":${STATIC_INTERFACE}$" | head -1 | cut -d: -f1 || true)
  if [ -z "$NM_CONN" ]; then
    NM_CONN="Wired connection 1"
    echo "[Static IP] No active NM connection on ${STATIC_INTERFACE}, using '${NM_CONN}'"
  fi
  EXISTING_IP=$(nmcli -g ipv4.addresses con show "$NM_CONN" 2>/dev/null || true)
  if [ "$EXISTING_IP" = "${STATIC_IP}/24" ]; then
    echo "[Static IP] Already configured in NetworkManager - skipping."
    STATIC_IP_CONFIGURED=true
  else
    nmcli con mod "$NM_CONN" ipv4.addresses "${STATIC_IP}/24" \
                             ipv4.gateway "${STATIC_GATEWAY}" \
                             ipv4.dns "${STATIC_DNS}" \
                             ipv4.method manual 2>/dev/null
    echo "[Static IP] Configured via NetworkManager (connection: ${NM_CONN})"
    STATIC_IP_CONFIGURED=true
  fi
else
  echo "[Static IP] WARNING: Neither dhcpcd nor NetworkManager found."
  echo "             Static IP must be configured manually."
fi

if [ "$STATIC_IP_CONFIGURED" = true ] && [ "$CURRENT_IP" != "$STATIC_IP" ]; then
  echo "[Static IP] NOTE: Currently ${CURRENT_IP:-unknown} - will become ${STATIC_IP} after reboot."
fi
echo ""

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

retry "apt-get update" sudo apt-get update -qq
retry "apt-get install" sudo apt-get install -y \
    git curl autossh mosquitto mosquitto-clients \
    python3-pip python3-dev libglib2.0-dev bluetooth bluez \
    jq arp-scan nmap

# Node.js 20 (required by Vite 8 / React 19 frontend build)
if ! command -v node &>/dev/null || [[ $(node -v | cut -d. -f1 | tr -d v) -lt 20 ]]; then
    echo "  Installing Node.js 20 (required by Vite 8)..."
    retry "Node.js setup script" bash -c 'curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -'
    retry "Node.js install" sudo apt-get install -y nodejs
fi

# pm2 global
if ! command -v pm2 &>/dev/null; then
    retry "pm2 global install" sudo npm install -g pm2
fi

echo "  Node $(node -v), npm $(npm -v), pm2 $(pm2 -v 2>/dev/null || echo 'installed')"

# ── Sudoers: let the pi user run arp-scan and nmap without a password ──
# Camera discovery (cameraDiscovery.js) needs sudo arp-scan/nmap, but PM2
# runs as user pi without a TTY, so sudo silently fails without NOPASSWD.
sudo tee /etc/sudoers.d/pi-awesomliving > /dev/null << 'SUDOEOF'
pi ALL=(ALL) NOPASSWD: /usr/sbin/arp-scan
pi ALL=(ALL) NOPASSWD: /usr/bin/nmap
SUDOEOF
sudo chmod 0440 /etc/sudoers.d/pi-awesomliving
echo "  Sudoers: arp-scan + nmap NOPASSWD for ${PI_USER}"


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
function parseCameraConfig() {
  const configStr = process.env.CAMERA_CONFIG || "";
  if (configStr) {
    const entries = configStr.split(";;").filter(Boolean);
    return entries.map(entry => {
      const [stream_name, ip, user, pass] = entry.split("|");
      return { stream_name, ip, user, pass };
    });
  }
  // No cameras pre-configured — they are paired via Pi Dashboard UI
  return [];
}

const cameras = parseCameraConfig();
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
async function isCameraAlive(cam) {
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
    const frameRes = await fetch(
      `${GO2RTC_API}/api/frame.jpeg?src=${cam.stream_name}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (frameRes.ok) {
      console.log(`\x1b[32m[heartbeat] ${cam.stream_name} alive (go2rtc frame OK)\x1b[0m`);
      return true;
    }
    console.log(`\x1b[33m[heartbeat] ${cam.stream_name} frame grab failed: status ${frameRes.status}\x1b[0m`);
  } catch (_) {
    console.log(`\x1b[33m[heartbeat] ${cam.stream_name} frame grab timed out\x1b[0m`);
  }
  return false;
}

// Probe all cameras and send bulk heartbeat
async function sendBulkHeartbeat() {
  try {
    // Probe all cameras in parallel
    const results = await Promise.all(
      cameras.map(async (cam) => {
        const alive = await isCameraAlive(cam);
        return { stream_name: cam.stream_name, alive };
      })
    );

    // Only include cameras that are alive
    const aliveCameras = results
      .filter(r => r.alive)
      .map(r => ({
        stream_name: r.stream_name,
        camera_last_seen: new Date().toISOString(),
      }));

    if (aliveCameras.length === 0) {
      console.log(`\x1b[33m[heartbeat] no cameras reachable — skipping bulk heartbeat\x1b[0m`);
      return;
    }

    const res = await fetch(`${BACKEND_URL}/api/camera/bulk-heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-hub-secret": HUB_SECRET },
      body: JSON.stringify({ cameras: aliveCameras }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      console.log(`\x1b[32m[heartbeat] bulk heartbeat OK (${aliveCameras.length}/${cameras.length} cameras alive)\x1b[0m`);
    } else {
      console.warn(`\x1b[33m[heartbeat] bulk heartbeat ${res.status}: ${await res.text()}\x1b[0m`);
    }
  } catch (err) {
    console.warn(`\x1b[33m[heartbeat] bulk heartbeat failed: ${err.message}\x1b[0m`);
  }
}

// Start heartbeat loop
sendBulkHeartbeat();
setInterval(sendBulkHeartbeat, HEARTBEAT_INTERVAL);
console.log(`\x1b[32m[heartbeat] started (every ${HEARTBEAT_INTERVAL / 1000}s to ${BACKEND_URL}, ${cameras.length} camera(s))\x1b[0m`);

// Health endpoint — reports status of ALL cameras
app.get("/health", async (_req, res) => {
  const results = await Promise.all(
    cameras.map(async (cam) => {
      const alive = await isCameraAlive(cam);
      return { stream_name: cam.stream_name, ip: cam.ip, status: alive ? "online" : "offline" };
    })
  );
  const allOnline = results.every(r => r.status === "online");
  const anyOnline = results.some(r => r.status === "online");
  res.json({
    status: allOnline ? "ok" : anyOnline ? "partial" : "all_cameras_offline",
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
retry "camera-wrapper npm install" npm install --silent
pm2 delete camera-wrapper 2>/dev/null || true
BACKEND_URL="${EC2_BACKEND}" HUB_SECRET="${HUB_SECRET}" CAMERA_CONFIG="${CAMERA_CONFIG}" \
  pm2 start go2rtc.service.js --name camera-wrapper
check_pm2_health "camera-wrapper"
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
    retry "go2rtc download" curl -fsSL "https://github.com/AlexxIT/go2rtc/releases/latest/download/${GO2RTC_BIN}" -o /tmp/go2rtc
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
sleep 3
check_service_health "go2rtc"
echo "  go2rtc running on port 1984 (${#CAMERAS[@]} streams)"

# Cloudflare named tunnel is configured in section 8, routing
# TUNNEL_HOSTNAME → localhost:1984 for public camera stream access.


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
check_service_health "mosquitto"
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
    retry "zigbee2mqtt git clone" git clone --depth 1 https://github.com/Koenkk/zigbee2mqtt.git
    cd "$Z2M_DIR"
    retry "zigbee2mqtt npm install" npm install
    npm run build
else
    echo "  zigbee2mqtt already cloned, updating..."
    cd "$Z2M_DIR"
    retry "zigbee2mqtt git pull" git pull
    retry "zigbee2mqtt npm install" npm install
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
    "js-yaml": "^4.1.0",
    "dotenv": "^16.5.0"
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
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env BEFORE reading env vars (without this, process.env.BACKEND_URL
// is always undefined and the fallback URL is used — the root cause of the
// "400 from wrong backend" bug).
dotenv.config({ path: path.join(__dirname, ".env") });

// ── Configuration ──
const BACKEND_URL = process.env.BACKEND_URL || "https://awesomliving.com/api/device-event";
const SECRET_KEY  = process.env.SECRET_KEY  || "jwt_secret_of_awesomliving_app";
const Z2M_CONFIG  = process.env.Z2M_CONFIG_PATH || "/home/pi/zigbee2mqtt/data/configuration.yaml";

// ── Device state tracking ──
const deviceStates = {};
const lastSwitchEvents = {};

// ── Device store (persisted to JSON file) ──
const DEVICE_STORE_PATH = path.join(__dirname, "devices.json");

const loadDevices = () => {
  try { return JSON.parse(fs.readFileSync(DEVICE_STORE_PATH, "utf8")); }
  catch { return []; }
};

const saveDevices = (devices) => {
  fs.writeFileSync(DEVICE_STORE_PATH, JSON.stringify(devices, null, 2));
};

const getDevices = () => loadDevices();

const upsertDevice = async ({ ieee_address, name, type }) => {
  const devices = loadDevices();
  const idx = devices.findIndex(d => d.ieee_address === ieee_address);
  if (idx >= 0) {
    if (name) devices[idx].name = name;
    if (type) devices[idx].type = type;
    devices[idx].last_seen = new Date().toISOString();
  } else {
    devices.push({ ieee_address, name: name || ieee_address, type: type || "zigbee", last_seen: new Date().toISOString() });
  }
  saveDevices(devices);
};

// ── Motion-sensor debounce ──
// PIR sensors toggle occupancy rapidly (true→false→true in seconds).
const MOTION_COOLDOWN_MS   = 30 * 1000;  // ignore repeated "true" within 30s
const MOTION_FALSE_DELAY_MS = 60 * 1000; // wait 60s of silence before sending "false"
const motionLastSentTrue = {};   // friendlyName → timestamp
const motionFalseTimers  = {};   // friendlyName → setTimeout id

// Presence sensors (SNZB-06P) — distinct from PIR motion sensors
const PRESENCE_KEYS = ["presence", "occupancy_sensitivity", "occupancy_timeout"];
const isPresencePayload = (data) => PRESENCE_KEYS.some((k) => data[k] !== undefined);

// ── Zigbee2MQTT config readers ──
const getKnownIeeeSet = () => {
  try {
    const config = yaml.load(fs.readFileSync(Z2M_CONFIG, "utf8"));
    return new Set(Object.keys(config.devices || {}));
  } catch { return new Set(); }
};

const getFriendlyToIeeeMap = () => {
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
const sendToBackend = async (friendlyName, resolvedType, data) => {
  try {
    await axios.post(BACKEND_URL, {
      device: friendlyName, type: resolvedType, data
    }, { headers: { "x-zigbee-secret": SECRET_KEY }, timeout: 10000 });
    console.log(`✅ ${resolvedType} sent for ${friendlyName}`);
  } catch (err) {
    console.log("❌ Backend error:", err.message, err.response?.status, err.response?.data);
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
  const presenceDevices = getDevices().filter((d) => d.type === "presence");
  for (const d of presenceDevices) {
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
        await upsertDevice({ ieee_address: ieee, name: friendly, type: "zigbee" });
      }
      if (data.type === "device_interview" && data.data?.status === "successful" && data.data?.ieee_address) {
        const ieee = data.data.ieee_address;
        const exposes = data.data?.definition?.exposes || [];
        const defDesc = (data.data?.definition?.description || "").toLowerCase();
        let detectedType = "zigbee";
        // occupancy in Z2M exposes = PIR motion sensor; presence = mmWave/radar.
        if (defDesc.includes("motion") || exposes.some(e => e.name === "occupancy")) detectedType = "motion";
        else if (defDesc.includes("contact") || defDesc.includes("door") || defDesc.includes("window") || exposes.some(e => e.name === "contact")) detectedType = "contact";
        else if (defDesc.includes("button") || defDesc.includes("switch") || defDesc.includes("remote") || exposes.some(e => e.name === "action")) detectedType = "switch";
        else if (defDesc.includes("presence") || exposes.some(e => e.name === "presence" || PRESENCE_KEYS.includes(e.name))) detectedType = "presence";
        else if (defDesc.includes("temperature") || defDesc.includes("humidity")) detectedType = "temperature";
        else if (defDesc.includes("leak") || defDesc.includes("water")) detectedType = "leak";
        console.log("📋 Interview done:", ieee, "→", detectedType);
        await upsertDevice({ ieee_address: ieee, type: detectedType });
      }
      return;
    }

    if (topic.startsWith("zigbee2mqtt/bridge/")) return;
    if (topic.endsWith("/get") || topic.endsWith("/set")) return;

    const friendlyName = topic.split("/")[1];
    const friendlyToIeeeMap = getFriendlyToIeeeMap();
    const ieee_address = friendlyToIeeeMap[friendlyName];
    if (!ieee_address) {
      console.log("❌ IEEE not found for:", friendlyName);
      return;
    }

    const knownIeeeSet = getKnownIeeeSet();
    if (!knownIeeeSet.has(ieee_address)) {
      console.log("🚫 Unknown device blocked:", ieee_address);
      return;
    }

    console.log("📡 Device:", friendlyName, "| Data:", JSON.stringify(data));

    // ── Switch dedup (3s window) ──
    const earlyAction = data.action || data.click || data.state;
    if (earlyAction) {
      const earlyKey = `${friendlyName}:${earlyAction}`;
      const earlyNow = Date.now();
      const earlyStored = lastSwitchEvents[earlyKey];
      if (earlyStored && earlyNow - earlyStored < 3000) {
        console.log(`🔁 Dedup: ${earlyKey} (${earlyNow - earlyStored}ms)`);
        return;
      }
      lastSwitchEvents[earlyKey] = earlyNow;
    }

    // ── Occupancy / Presence sensors ──
    if (data.occupancy !== undefined || data.presence !== undefined) {
      const payloadType = isPresencePayload(data) ? "presence" : null;
      const allDevices = getDevices();
      const storedDevice = allDevices.find(d => d.ieee_address === ieee_address);
      const resolvedType = payloadType || storedDevice?.type || "motion";

      // Self-heal device store if type was wrong
      if (payloadType && storedDevice?.type !== payloadType) {
        await upsertDevice({ ieee_address, name: friendlyName, type: payloadType });
      }

      const currentValue = data.presence !== undefined ? data.presence : data.occupancy;
      await upsertDevice({ ieee_address, name: friendlyName });

      // ── PRESENCE sensors: send every state change (no debounce) ──
      if (resolvedType === "presence") {
        if (!(friendlyName in deviceStates)) deviceStates[friendlyName] = null;
        const stateChanged = deviceStates[friendlyName] !== currentValue;
        deviceStates[friendlyName] = currentValue;
        if (stateChanged) {
          console.log(`🧘 Presence state: ${currentValue}`);
          await sendToBackend(friendlyName, resolvedType, data);
        }
        return;
      }

      // ── MOTION sensors: debounced ──
      const now = Date.now();

      if (currentValue === true) {
        // Cancel any pending "room cleared" timer
        if (motionFalseTimers[friendlyName]) {
          clearTimeout(motionFalseTimers[friendlyName]);
          motionFalseTimers[friendlyName] = null;
          console.log(`⏱️ Cancelled pending false for: ${friendlyName}`);
        }

        // Only send if cooldown expired
        const lastSent = motionLastSentTrue[friendlyName] || 0;
        if (now - lastSent >= MOTION_COOLDOWN_MS) {
          deviceStates[friendlyName] = true;
          motionLastSentTrue[friendlyName] = now;
          console.log(`🚶 Motion: true`);
          await sendToBackend(friendlyName, resolvedType, data);
        } else {
          console.log(`⏳ Motion cooldown: ${friendlyName} (${Math.round((MOTION_COOLDOWN_MS - (now - lastSent)) / 1000)}s left)`);
        }
      } else {
        // occupancy: false — delay before confirming room is clear
        if (!motionFalseTimers[friendlyName]) {
          console.log(`⏱️ Motion false delayed ${MOTION_FALSE_DELAY_MS / 1000}s for: ${friendlyName}`);
          motionFalseTimers[friendlyName] = setTimeout(async () => {
            motionFalseTimers[friendlyName] = null;
            deviceStates[friendlyName] = false;
            console.log(`🚶 Motion: false (confirmed after ${MOTION_FALSE_DELAY_MS / 1000}s silence)`);
            await sendToBackend(friendlyName, resolvedType, { ...data, occupancy: false });
          }, MOTION_FALSE_DELAY_MS);
        }
      }
      return;
    }

    // ── Switch / Emergency button ──
    const switchAction = data.action || data.click || data.state;
    if (switchAction) {
      await upsertDevice({ ieee_address, name: friendlyName, type: "switch" });
      console.log("🔘 Switch:", switchAction);
      await sendToBackend(friendlyName, "switch", data);
    }

    // ── Contact sensors (door/window) ──
    if (data.contact !== undefined) {
      const contactKey = `contact:${friendlyName}`;
      if (!(contactKey in deviceStates)) deviceStates[contactKey] = null;
      const contactChanged = deviceStates[contactKey] !== data.contact;
      deviceStates[contactKey] = data.contact;
      await upsertDevice({ ieee_address, name: friendlyName, type: "contact" });
      if (contactChanged) {
        console.log("🚪 Contact:", data.contact ? "CLOSED" : "OPEN");
        await sendToBackend(friendlyName, "contact", data);
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
retry "mqtt-bridge npm install" npm install --silent
pm2 delete mqtt-bridge 2>/dev/null || true
BACKEND_URL="${BACKEND_API_URL}" SECRET_KEY="${ZIGBEE_SECRET}" \
  pm2 start mqtt.js --name mqtt-bridge --cwd "$MQTT_DIR"
check_pm2_health "mqtt-bridge"
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
  - Emergency (0x0D) forwarding with decoded fields (v20)
  - time_sync_count tracking per connection
  - Configurable log level, time format debug knob
  - v20: All 13 raw fields forwarded (added signal_quality)

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
IN_BED_STATUSES = {1, 2, 3, 5, 6}

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
    """Corrected byte layout (Aug 2026, verified against production data):
    p[0:2]=protocol markers (0x6A,0x8A), p[2:4]=timer, p[4]=HR, p[5]=RR,
    p[6]=status, p[7]=battery, p[8]=reserved, p[9]=signal, p[10]=movement.
    v20: All 13 raw device fields now returned (added signal_quality)."""
    p = frame["payload"]
    if len(p) < 11: return {}
    sc = p[6]
    return {
        "heart_rate": p[4] if p[4] != 0xFF else None,
        "respiration_rate": p[5] if p[5] != 0xFF else None,
        "status_code": sc, "status": STATUS_MAP.get(sc, f"unknown_{sc}"),
        "in_bed": sc in IN_BED_STATUSES, "out_of_bed": sc == 4,
        "apnea_suspected": sc == 2, "snoring": sc == 3,
        "body_movement": p[10] if len(p) > 10 else 0,
        "battery_level": p[7] if len(p) > 7 else None,
        "signal_quality": p[9] if len(p) > 9 else None,
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
                            log.info("  VITALS sn=%s HR=%s RR=%s status=%s battery=%s signal=%s",
                                     sn, vitals.get("heart_rate"), vitals.get("respiration_rate"),
                                     vitals.get("status"), vitals.get("battery_level"),
                                     vitals.get("signal_quality"))
                            asyncio.get_event_loop().run_in_executor(None, forward_to_backend, sn, vitals)

                elif cmd == CMD_SLEEP_STAGE:
                    log.info("  Sleep stage frame (%d bytes)", len(raw))
                    asyncio.get_event_loop().run_in_executor(
                        None, forward_to_backend, sn, {"type": "sleep_stage", "raw_hex": raw.hex()})

                elif cmd == CMD_EMERGENCY:
                    log.warning("  EMERGENCY frame from sn=%s!", sn)
                    emergency_data = {
                        "type": "emergency", "life_abnormality": True,
                        "status_code": 5, "status": "life_abnormality",
                        "in_bed": True, "out_of_bed": False,
                        "heart_rate": None, "respiration_rate": None,
                        "raw_hex": raw.hex(),
                    }
                    asyncio.get_event_loop().run_in_executor(
                        None, forward_to_backend, sn, emergency_data)

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

# ── Deploy glk_provision.py (BLE scan + pair with retries, called by server.js) ──
cat > "$GLK_DIR/glk_provision.py" << 'GLKPROVEOF'
#!/usr/bin/env python3
"""
glk_provision.py — BLE scan & provisioning for the GLK AI Smart Sleep Monitor.

Called by server.js:
    POST /api/glk/scan     ->  python3 glk_provision.py scan --timeout 8
    POST /api/glk/pair     ->  python3 glk_provision.py provision \
                                  --address <MAC> --ssid <SSID> --password <PWD> \
                                  --pi-ip <IP> --port 8766

v18 fixes (cumulative):
  - 3x BLE connection retries with adapter health check + cache cleanup
  - Pre-connect verification scan (warms up BlueZ adapter after /scan)
  - hciconfig hci0 reset (more reliable than bluetoothctl on RPi)
  - _exc_detail() — never produces empty error messages
  - Separate connect (15s) vs GATT write (15s) timeouts
  - _result() helper — response always has all 4 fields
  - Scan exception caught (won't crash with unhandled traceback)
  - SINGLE fff2 subscription for both WiFi + server config writes
    (fixes WiFi ACK being lost due to CCCD propagation delay on first subscribe)
  - 0.5s settle after subscribe to let CCCD notification enable propagate
  - 0.2s inter-chunk delay (up from 0.12s)
"""
from __future__ import annotations
import argparse, asyncio, json, subprocess, sys, os, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import glk_protocol as glk

ADV_PREFIX = "LZ-OTA"
BLE_CONNECT_RETRIES = 3
BLE_RETRY_DELAY = 3.0

def _dbg(msg):
    print(f"[GLK] {msg}", file=sys.stderr, flush=True)

def _exc_detail(e):
    s = str(e)
    if s: return f"{type(e).__name__}: {s}"
    return f"{type(e).__name__}: {e!r}"

def _result(success, wifi_ack=False, server_ack=False, detail=""):
    return {"success": bool(success), "wifi_ack": bool(wifi_ack),
            "server_ack": bool(server_ack), "detail": str(detail)}

def _reset_bluetooth_adapter():
    try:
        _dbg("Resetting Bluetooth adapter ...")
        hci_ok = subprocess.run(["hciconfig", "hci0", "reset"],
            capture_output=True, timeout=5, check=False)
        if hci_ok.returncode == 0:
            _dbg("Adapter reset via hciconfig hci0 reset"); time.sleep(1.0)
        else:
            subprocess.run(["bluetoothctl", "power", "off"],
                capture_output=True, timeout=5, check=False)
            time.sleep(0.5)
            subprocess.run(["bluetoothctl", "power", "on"],
                capture_output=True, timeout=5, check=False)
            time.sleep(0.5)
            _dbg("Adapter power-cycled via bluetoothctl")
    except Exception as e:
        _dbg(f"Adapter reset (non-fatal): {_exc_detail(e)}")

def _remove_cached_device(address):
    try:
        _dbg(f"Removing cached device {address} from BlueZ ...")
        result = subprocess.run(["bluetoothctl", "remove", address],
            capture_output=True, timeout=5, text=True, check=False)
        _dbg(f"  remove result: {result.stdout.strip()} / {result.stderr.strip()}")
    except Exception as e:
        _dbg(f"  remove cached device (non-fatal): {_exc_detail(e)}")

def _check_adapter_health():
    try:
        result = subprocess.run(["bluetoothctl", "show"],
            capture_output=True, timeout=5, text=True, check=False)
        output = result.stdout
        _dbg(f"Adapter info:\n{output.strip()}")
        powered = "Powered: yes" in output
        if not powered:
            _dbg("WARNING: Adapter NOT powered, attempting power on ...")
            subprocess.run(["bluetoothctl", "power", "on"],
                capture_output=True, timeout=5, check=False)
            time.sleep(0.5)
            result2 = subprocess.run(["bluetoothctl", "show"],
                capture_output=True, timeout=5, text=True, check=False)
            powered = "Powered: yes" in result2.stdout
            _dbg(f"After power-on: Powered={'yes' if powered else 'NO'}")
        return powered
    except Exception as e:
        _dbg(f"Adapter health check (non-fatal): {_exc_detail(e)}")
        return True

async def scan_devices(timeout=8.0):
    from bleak import BleakScanner
    _dbg(f"Starting BLE scan (timeout={timeout}s) ...")
    devices = []
    discovered = await BleakScanner.discover(timeout=timeout, return_adv=True)
    _dbg(f"Scan complete — {len(discovered)} total BLE devices seen")
    for device, adv_data in discovered.values():
        name = adv_data.local_name or device.name or ""
        if name.startswith(ADV_PREFIX):
            serial = name[len(ADV_PREFIX):].strip()
            devices.append({"address": device.address, "name": name,
                            "serial": serial, "rssi": adv_data.rssi})
            _dbg(f"  Found GLK: {name} @ {device.address} (RSSI {adv_data.rssi})")
    _dbg(f"GLK devices found: {len(devices)}")
    return devices

def _reply_is_success(data, msg_type):
    if not data or len(data) < 5 or data[0] != 0xCD:
        _dbg(f"  Reply check: invalid envelope (len={len(data) if data else 0})")
        return False
    actual_type = data[1]
    type_match = actual_type == (msg_type & 0xFF)
    _dbg(f"  Reply check: type=0x{actual_type:02X} (expected 0x{msg_type:02X}, "
         f"{'MATCH' if type_match else 'MISMATCH'}) "
         f"content=0x{data[4]:02X} ({'SUCCESS' if data[4] == 0x00 else 'FAIL'})")
    return data[4] == 0x00

async def _verify_device_present(address, timeout=5.0):
    from bleak import BleakScanner
    _dbg(f"Pre-connect scan: verifying {address} ({timeout}s) ...")
    try:
        discovered = await BleakScanner.discover(timeout=timeout, return_adv=True)
        for device, _adv in discovered.values():
            if device.address.upper() == address.upper():
                _dbg(f"Pre-connect scan: confirmed (RSSI {_adv.rssi})")
                return True
        _dbg(f"Pre-connect scan: NOT found among {len(discovered)} devices")
        return False
    except Exception as e:
        _dbg(f"Pre-connect scan (non-fatal): {_exc_detail(e)}")
        return True

async def _connect_with_retries(address, timeout):
    from bleak import BleakClient
    last_exc = None
    for attempt in range(1, BLE_CONNECT_RETRIES + 1):
        try:
            _dbg(f"Connection attempt {attempt}/{BLE_CONNECT_RETRIES} to {address} ...")
            client = BleakClient(address, timeout=timeout)
            await client.connect()
            if client.is_connected:
                _dbg(f"Connected on attempt {attempt}"); return client
            raise RuntimeError("connect() succeeded but is_connected is False")
        except Exception as e:
            last_exc = e
            _dbg(f"Attempt {attempt} FAILED: {_exc_detail(e)}")
            try: await client.disconnect()
            except Exception: pass
            if attempt < BLE_CONNECT_RETRIES:
                _dbg(f"Retrying in {BLE_RETRY_DELAY}s ...")
                _remove_cached_device(address)
                await asyncio.sleep(BLE_RETRY_DELAY)
    raise last_exc

async def provision_device(address, ssid, password, pi_ip, port="8766", timeout=20.0):
    """Write WiFi + server config over BLE.
    KEY: subscribe to fff2 ONCE for both writes, with a 0.5s settle after
    subscribing.  Per-write subscribe/unsubscribe caused the first WiFi ACK
    to be missed (CCCD propagation delay in BlueZ on fresh connections).
    """
    try:
        wifi_chunks = glk.build_wifi_config(ssid, password)
        server_chunks = glk.build_server_config(pi_ip, str(port))
    except Exception as e:
        _dbg(f"Config build failed: {_exc_detail(e)}")
        return _result(False, detail=f"config build error: {_exc_detail(e)}")

    _dbg(f"WiFi config: {len(wifi_chunks)} chunks, Server config: {len(server_chunks)} chunks")

    adapter_ok = _check_adapter_health()
    if not adapter_ok:
        _dbg("Adapter check failed — resetting"); _reset_bluetooth_adapter()
    _remove_cached_device(address)

    device_present = await _verify_device_present(address, timeout=5.0)
    if not device_present:
        _dbg("WARNING: device not seen in pre-connect scan — will still attempt")
    _remove_cached_device(address)

    connect_timeout = min(timeout, 15.0)
    _dbg(f"Connecting to {address} (per-attempt timeout={connect_timeout}s) ...")

    client = None
    try:
        client = await _connect_with_retries(address, connect_timeout)
        for service in client.services:
            _dbg(f"  Service: {service.uuid}")
            for char in service.characteristics:
                _dbg(f"    Char: {char.uuid} [{', '.join(char.properties)}]")

        write_char = notify_char = None
        for service in client.services:
            for char in service.characteristics:
                if char.uuid == glk.BLE_WRITE_CHAR: write_char = char
                if char.uuid == glk.BLE_NOTIFY_CHAR: notify_char = char
        if not write_char:
            return _result(False, detail="BLE error: write characteristic fff1 not found")
        if not notify_char:
            return _result(False, detail="BLE error: notify characteristic fff2 not found")
        _dbg(f"Characteristics verified: fff1=[{', '.join(write_char.properties)}] "
             f"fff2=[{', '.join(notify_char.properties)}]")

        # ── Subscribe ONCE for both WiFi and server config writes ──
        reply_data = {"bytes": None}
        reply_event = asyncio.Event()
        def on_notify(_char, data):
            reply_data["bytes"] = bytes(data)
            _dbg(f"  Notification on fff2: {data.hex()} ({len(data)} bytes)")
            reply_event.set()

        _dbg(f"Subscribing to notifications on {glk.BLE_NOTIFY_CHAR} ...")
        await client.start_notify(glk.BLE_NOTIFY_CHAR, on_notify)
        # CRITICAL: let CCCD notification-enable propagate through BlueZ
        _dbg("Waiting 0.5s for CCCD to propagate ...")
        await asyncio.sleep(0.5)

        write_timeout = 15.0

        # Step 1: Write WiFi config (0x1F)
        _dbg("Step 1: Writing WiFi config ...")
        reply_event.clear()
        reply_data["bytes"] = None
        for i, chunk in enumerate(wifi_chunks):
            _dbg(f"  [WiFi] Writing chunk {i+1}/{len(wifi_chunks)}: {chunk.hex()}")
            await client.write_gatt_char(glk.BLE_WRITE_CHAR, chunk, response=False)
            await asyncio.sleep(0.2)
        _dbg(f"  [WiFi] All chunks written, waiting for reply ({write_timeout}s) ...")
        try:
            await asyncio.wait_for(reply_event.wait(), timeout=write_timeout)
            wifi_ack = _reply_is_success(reply_data["bytes"], glk.BLE_MSG_WIFI)
        except asyncio.TimeoutError:
            _dbg("  [WiFi] TIMEOUT — no reply from device"); wifi_ack = False

        await asyncio.sleep(0.5)

        # Step 2: Write server config (0x23)
        _dbg("Step 2: Writing server config ...")
        reply_event.clear()
        reply_data["bytes"] = None
        for i, chunk in enumerate(server_chunks):
            _dbg(f"  [Server] Writing chunk {i+1}/{len(server_chunks)}: {chunk.hex()}")
            await client.write_gatt_char(glk.BLE_WRITE_CHAR, chunk, response=False)
            await asyncio.sleep(0.2)
        _dbg(f"  [Server] All chunks written, waiting for reply ({write_timeout}s) ...")
        try:
            await asyncio.wait_for(reply_event.wait(), timeout=write_timeout)
            server_ack = _reply_is_success(reply_data["bytes"], glk.BLE_MSG_SERVER)
        except asyncio.TimeoutError:
            _dbg("  [Server] TIMEOUT — no reply from device"); server_ack = False

        try: await client.stop_notify(glk.BLE_NOTIFY_CHAR)
        except Exception: pass

    except Exception as e:
        _dbg(f"BLE error: {_exc_detail(e)}")
        return _result(False, detail=f"BLE error: {_exc_detail(e)}")
    finally:
        if client:
            try: await client.disconnect(); _dbg("Disconnected")
            except Exception: pass

    success = bool(wifi_ack and server_ack)
    detail = "provisioned" if success else (
        "wifi config not acknowledged" if not wifi_ack
        else "server config not acknowledged")
    _dbg(f"Result: success={success}, wifi_ack={wifi_ack}, server_ack={server_ack}")
    if success: _dbg("*** PROVISIONING COMPLETE ***")
    return _result(success, wifi_ack=wifi_ack, server_ack=server_ack, detail=detail)

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
                address=args.address, ssid=args.ssid, password=args.password,
                pi_ip=args.pi_ip, port=args.port, timeout=args.timeout))
            print(json.dumps(result))
        except Exception as e:
            _dbg(f"Provision exception (outer): {_exc_detail(e)}")
            print(json.dumps(_result(False, detail=f"provision error: {_exc_detail(e)}")))
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
sleep 3
check_service_health "glk-bridge"
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
# Uses REPO_BRANCH set earlier: qa → 'qa' branch, prod → 'main' branch
if [ -d "${DASHBOARD_DIR}/.git" ]; then
    echo "  Repo already exists — switching to ${REPO_BRANCH} branch and pulling latest..."
    cd "${DASHBOARD_DIR}"
    retry "dashboard git fetch" git fetch origin
    git checkout "${REPO_BRANCH}"
    retry "dashboard git pull" git pull origin "${REPO_BRANCH}"
else
    if [ -d "${DASHBOARD_DIR}" ]; then
        echo "  Old non-git dashboard found — backing up..."
        mv "${DASHBOARD_DIR}" "${DASHBOARD_DIR}.backup.$(date +%Y%m%d%H%M%S)"
    fi
    echo "  Cloning Pi Dashboard repo (branch: ${REPO_BRANCH})..."
    retry "dashboard git clone" git clone -b "${REPO_BRANCH}" "${DASHBOARD_REPO}" "${DASHBOARD_DIR}"
fi
echo "  Pi Dashboard repo on branch: ${REPO_BRANCH}"

# ── Post-clone code patches ─────────────────────────────────────────────
# These fixes exist locally but haven't been pushed to GitHub yet.
# The patches ensure the Pi gets correct code regardless of repo state.
# Once pushed to GitHub, these become harmless no-ops (overwrite with same).
echo "  Applying code patches (camera scan + device sync + backend URL)..."

# Patch 1: deviceStore.js — fix REMOTE_BACKEND URL (old IP → domain)
# Fix old hardcoded IP → current domain, then ensure it points to selected env
sed -i 's|"http://51.20.102.125"|"https://awesomliving.com"|' "${DASHBOARD_DIR}/backend/services/deviceStore.js"
if [ "$DEPLOY_ENV" = "qa" ]; then
  sed -i 's|"https://awesomliving.com"|"https://qa.awesomliving.com"|' "${DASHBOARD_DIR}/backend/services/deviceStore.js"
fi

# Patch 2: mqttClient.js — Zigbee device auto-discovery + type inference (v22)
# The GitHub version has NO handler for zigbee2mqtt/bridge/devices OR for
# individual device messages (zigbee2mqtt/0x<ieee>), so Zigbee devices never
# get written to devices.json and the Device Listing page shows 0 devices.
# This complete file adds:
#   - detect_zigbee_type() — infers sensor type from MQTT payload keys
#   - handle_bridge_devices() — syncs Z2M's full device list to devices.json
#   - handle_device_message() — catches individual device messages for devices
#     that weren't in the bridge list (e.g. already-paired sensors)
cat > "${DASHBOARD_DIR}/backend/mqtt/mqttClient.js" << 'MQTTCLIENTEOF'
import mqtt from "mqtt";
import { getIO } from "../socket/socket.js";
import fs from "fs";
import yaml from "js-yaml";
import { pendingDeletes } from "../utils/deleteState.js";
import { deleteDevice, upsertDevice, getDevices } from "../services/deviceStore.js";

const CONFIG_PATH = "/home/pi/zigbee2mqtt/data/configuration.yaml";
const client = mqtt.connect("mqtt://localhost");

// ── Zigbee sensor type detection ────────────────────────────────────────
// Infer the device type from its payload keys. The first matching key wins.
const detect_zigbee_type = (payload) => {
  if (payload.contact !== undefined) return "contact"; // door/window sensor
  if (payload.occupancy !== undefined) return "motion"; // motion sensor
  if (payload.presence !== undefined) return "presence"; // presence sensor
  if (payload.action !== undefined) return "button"; // emergency button
  return "zigbee"; // fallback — unknown Zigbee device
};

// ── Bridge device list handler ──────────────────────────────────────────
// Z2M publishes a full array of all paired devices on
// `zigbee2mqtt/bridge/devices` at startup and whenever a device joins or
// leaves. Upsert EVERY non-Coordinator device so its type gets refreshed
// even when it was already in devices.json (e.g. after a coordinator reset
// where the description was empty on the first sync).
const handle_bridge_devices = (raw) => {
  try {
    const z2m_devices = JSON.parse(raw);
    if (!Array.isArray(z2m_devices)) return;

    for (const dev of z2m_devices) {
      // Skip the Coordinator — it's the Zigbee USB dongle, not a sensor.
      if (dev.type === "Coordinator") continue;

      const ieee = dev.ieee_address;
      if (!ieee) continue;

      // Check BOTH description AND exposes array — exposes is more reliable
      // because it is populated even when Z2M hasn't finished interviewing
      // the device (description can be empty on fresh pairs).
      const desc = (dev.definition?.description || "").toLowerCase();
      const exposes = dev.definition?.exposes || [];
      const expose_types = exposes.map(e => (e.name || e.type || "").toLowerCase());
      let sensor_type = "zigbee";
      // occupancy in Z2M exposes = PIR motion sensor; presence = mmWave/radar.
      if (desc.includes("motion") || expose_types.includes("occupancy")) sensor_type = "motion";
      else if (desc.includes("contact") || desc.includes("door") || desc.includes("window") || expose_types.includes("contact")) sensor_type = "contact";
      else if (desc.includes("button") || desc.includes("switch") || desc.includes("remote") || expose_types.includes("action")) sensor_type = "switch";
      else if (desc.includes("presence") || expose_types.includes("presence")) sensor_type = "presence";
      else if (desc.includes("temperature") || desc.includes("humidity")) sensor_type = "temperature";
      else if (desc.includes("leak") || desc.includes("water")) sensor_type = "leak";

      upsertDevice({
        ieee_address: ieee,
        name: dev.friendly_name || ieee,
        type: sensor_type,
      });
    }
    console.log(`✅ Devices synced from Z2M: ${z2m_devices.filter(d => d.type !== "Coordinator").length} device(s)`);
  } catch (err) {
    console.error("⚠️ handle_bridge_devices error:", err.message);
  }
};

// ── Individual device message handler ───────────────────────────────────
// Messages on `zigbee2mqtt/0x<ieee>` carry live sensor data. If the device
// is not yet in devices.json, add it as unmapped with a type inferred from
// its payload.
const handle_device_message = (ieee, raw) => {
  try {
    const existing = getDevices();
    if (existing.some((d) => d.ieee_address === ieee)) return;

    const payload = JSON.parse(raw);
    const sensor_type = detect_zigbee_type(payload);

    upsertDevice({
      ieee_address: ieee,
      name: ieee,
      type: sensor_type,
    });

    console.log(
      `📡 New Zigbee device from message: ${ieee} (${sensor_type}) — added as unmapped`,
    );
  } catch {
    // Non-JSON message or parse error — ignore silently.
  }
};

client.on("connect", () => {
  console.log("MQTT Connected");
  client.subscribe("zigbee2mqtt/#");
});

client.on("message", (topic, message) => {
  const data = message.toString();

  // ── Z2M bridge device list (all paired devices) ─────────────────────
  if (topic === "zigbee2mqtt/bridge/devices") {
    handle_bridge_devices(data);
  }

  // ── Device remove confirmation ──────────────────────────────────────
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

  // ── Individual Zigbee device message (0x...) ────────────────────────
  // Topic pattern: zigbee2mqtt/0x<14-hex-chars>
  const device_match = topic.match(/^zigbee2mqtt\/(0x[0-9a-f]+)$/i);
  if (device_match) {
    handle_device_message(device_match[1], data);
  }

  // ── Forward all logs to the pairing page via Socket.IO ──────────────
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
const detectInterface = (range) => {
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
const getActiveInterfaces = () => {
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
const arpScan = (range, iface) =>
  new Promise((resolve) => {
    const ifaceArg = iface ? `--interface=${iface} ` : "";
    exec(
      `sudo arp-scan ${ifaceArg}${range}`,
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
const nmapScan = (range) =>
  new Promise((resolve) => {
    exec(
      `sudo nmap -sn ${range}`,
      { timeout: 60000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        const rows = [];
        const lines = (stdout || "").split("\n");
        let currentIp = null;
        for (const line of lines) {
          const ipMatch = line.match(/Nmap scan report for (\d+\.\d+\.\d+\.\d+)/);
          if (ipMatch) {
            currentIp = ipMatch[1];
          }
          const macMatch = line.match(/MAC Address:\s+([0-9A-F:]{17})/i);
          if (macMatch && currentIp) {
            rows.push({ ip: currentIp, mac: macMatch[1].toLowerCase() });
            currentIp = null;
          }
        }
        resolve(rows);
      },
    );
  });

// Check if arp-scan is available.
const hasArpScan = () =>
  new Promise((resolve) => {
    exec("which arp-scan", (error) => resolve(!error));
  });

// Find cameras by MAC vendor across the scanned subnets.
export const discoverCameras = async () => {
  const seen = new Map(); // ip -> mac
  const useArpScan = await hasArpScan();

  for (const range of SCAN_SUBNETS.split(/\s+/).filter(Boolean)) {
    let rows = [];
    if (useArpScan) {
      // Auto-detect the correct interface for this subnet
      const iface = detectInterface(range);
      if (iface) {
        console.log(`🔍 Camera scan: arp-scan ${range} on ${iface}`);
        rows = await arpScan(range, iface);
      } else {
        // No interface matches this subnet — try all active interfaces
        const active = getActiveInterfaces();
        for (const ifName of active) {
          console.log(`🔍 Camera scan: arp-scan ${range} on ${ifName} (fallback)`);
          const r = await arpScan(range, ifName);
          rows.push(...r);
        }
      }
    }

    // Fallback to nmap if arp-scan isn't installed or found nothing
    if (rows.length === 0) {
      console.log(`🔍 Camera scan: nmap -sn ${range} (fallback)`);
      rows = await nmapScan(range);
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

# Patch 4: server.js — add home field to device assignment API calls
# Devices created via assign-name (Zigbee), assign-camera (CpPlus), and
# glk/pair (GLK vitals) should include the Pi's configured home_id so the
# backend can link each device directly to its home. This patch adds
# home: readHubConfig().home_id to the three remote backend POST payloads.
SRVJS="${DASHBOARD_DIR}/backend/server.js"
if [ -f "$SRVJS" ]; then
  # Only patch if the home field isn't already present (idempotent).
  if ! grep -q 'home: readHubConfig().home_id' "$SRVJS"; then
    # assign-name (Zigbee): add home after room line
    sed -i '/sensor_type: zigbee_type,/{n;s#room: room || "bathroom",#room: room || "bathroom",\n        home: readHubConfig().home_id || undefined,#}' "$SRVJS"
    # assign-camera (CpPlus): add home after rtsp_url line
    sed -i '/rtsp_url: rtsp_url || null,/{
      # Only patch the assign-camera block (has hub_id: getHubId() nearby)
      N
      s#rtsp_url: rtsp_url || null,\n#rtsp_url: rtsp_url || null,\n        home: readHubConfig().home_id || undefined,\n#
    }' "$SRVJS"
    # glk/pair (Emfit/GLK): add home after room line in the glk pair block
    sed -i '/sr_num: serial,/{n;s#room: room || "bedroom",#room: room || "bedroom",\n      home: readHubConfig().home_id || undefined,#}' "$SRVJS"
    echo "  Patched server.js (added home field to device assignments)"
  else
    echo "  server.js already has home field — skipping patch"
  fi
fi

# Patch 5: server.js — fix assign-name crash when Z2M config has no devices section
# On a fresh install, Z2M's configuration.yaml may have no "devices:" key at all.
# The original code does `config.devices[zigbee_ieee]` which throws a TypeError
# when config.devices is undefined, producing a 500 error. This patch wraps the
# config read in try/catch and adds a null check for config.devices.
if [ -f "$SRVJS" ]; then
  if grep -q '!config\.devices\[zigbee_ieee\]' "$SRVJS"; then
    # Use node to do a reliable multi-line replacement
    node -e "
      const fs = require('fs');
      let src = fs.readFileSync('$SRVJS', 'utf8');

      // Replace the old pattern that crashes when config.devices is undefined
      const oldBlock = /\/\/ Step 2:.*?\n\s+const config = yaml\.load\(fs\.readFileSync\(CONFIG_PATH, .utf8.\)\);\n\s+if \(!config\.devices\[zigbee_ieee\]\) \{\n\s+return res\.status\(404\)\.json\(\{ error: .Device not found in Z2M. \}\);\n\s+\}\n\s+(const )?currentFriendlyName =\n?\s+config\.devices\[zigbee_ieee\]\.friendly_name \|\| zigbee_ieee;\n\n?\s+\/\/ Step 3:.*?\n\s+mqttClient\.publish\(\n\s+.zigbee2mqtt\/bridge\/request\/device\/rename.,\n\s+JSON\.stringify\(\{ from: currentFriendlyName, to: zigbee_name \}\),?\n\s+\);/s;

      const newBlock = \`// Step 2: Read Z2M config and rename if device is known there.
    // The device may exist in devices.json (discovered via MQTT bridge) but NOT
    // yet in Z2M's configuration.yaml (e.g. devices section missing on fresh
    // installs). Handle gracefully — skip the rename, still forward to backend.
    let currentFriendlyName = zigbee_ieee;
    try {
      const config = yaml.load(fs.readFileSync(CONFIG_PATH, \"utf8\"));
      if (config.devices && config.devices[zigbee_ieee]) {
        currentFriendlyName =
          config.devices[zigbee_ieee].friendly_name || zigbee_ieee;

        // Step 3: Rename via Z2M MQTT API
        mqttClient.publish(
          \"zigbee2mqtt/bridge/request/device/rename\",
          JSON.stringify({ from: currentFriendlyName, to: zigbee_name }),
        );
      } else {
        console.log(\"⚠️ Device not in Z2M config — skipping rename, will still map to backend:\", zigbee_ieee);
      }
    } catch (configErr) {
      console.log(\"⚠️ Could not read Z2M config — skipping rename:\", configErr.message);
    }\`;

      if (oldBlock.test(src)) {
        src = src.replace(oldBlock, newBlock);
        fs.writeFileSync('$SRVJS', src);
        console.log('  Patched server.js (assign-name Z2M config null check)');
      } else {
        console.log('  server.js assign-name pattern not found — may already be patched');
      }
    "
  else
    echo "  server.js assign-name already patched — skipping"
  fi
fi

echo "  Code patches applied (mqttClient.js, cameraDiscovery.js, deviceStore.js, server.js)"

# Patch 6: Deploy improved GLK files to dashboard's backend/glk/ directory.
# server.js reads glk_provision.py from its own backend/glk/ folder (via __dirname),
# NOT from the standalone $GLK_DIR (/home/pi/glk-bridge/). The repo's old version
# lacks write-with-response fallback, has too-short inter-chunk delays (0.12s vs 0.3s),
# and produces empty BLE error messages. The improved versions deployed to $GLK_DIR
# in section 6 must ALSO be copied here so the /api/glk/scan and /api/glk/pair
# endpoints use the same battle-tested code.
DASHBOARD_GLK="${DASHBOARD_DIR}/backend/glk"
if [ -d "$GLK_DIR" ] && [ -d "$DASHBOARD_DIR/backend" ]; then
    mkdir -p "$DASHBOARD_GLK"
    cp -f "$GLK_DIR/glk_protocol.py" "$DASHBOARD_GLK/glk_protocol.py"
    cp -f "$GLK_DIR/glk_provision.py" "$DASHBOARD_GLK/glk_provision.py"
    echo "  Deployed improved GLK files to ${DASHBOARD_GLK}/"
    echo "    glk_protocol.py — verified frame builders, 4-byte epoch time sync"
    echo "    glk_provision.py — single fff2 subscribe, CCCD settle delay, 3x connect retries"
fi

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
retry "dashboard backend npm install" npm install
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
retry "dashboard frontend npm install" npm install
# Patch auth.js to read VITE_BACKEND_URL (safe for both prod and QA — defaults
# to production when the env var isn't set). This fixes the token mismatch bug
# where the frontend hardcodes the production API URL even on a QA-configured Pi.
cat > "${DASHBOARD_DIR}/frontend/src/constants/auth.js" << 'AUTHEOF'
export const AUTH_STORAGE_KEY = "zigbee-dashboard-authenticated";
// Configurable via VITE_BACKEND_URL at build time; defaults to production.
export const BASE_URL =
  import.meta.env.VITE_BACKEND_URL || "https://awesomliving.com/api";
AUTHEOF
echo "  Patched frontend auth.js (reads VITE_BACKEND_URL)"

# Create frontend .env with the correct backend URL for this environment
cat > "${DASHBOARD_DIR}/frontend/.env" << FRONTENVEOF
VITE_BACKEND_URL=https://${EC2_DOMAIN}/api
FRONTENVEOF
echo "  Created frontend .env → ${EC2_DOMAIN}/api"

# Patch DeviceForm.jsx — add Temperature, Leak, and Zigbee options to the type
# dropdown so auto-detected types are always selectable in the edit form.
DEVICEFORM="${DASHBOARD_DIR}/frontend/src/pages/devices/DeviceForm.jsx"
if [ -f "$DEVICEFORM" ] && ! grep -q 'value="zigbee"' "$DEVICEFORM"; then
  sed -i '/<option value="presence">Presence<\/option>/a\              <option value="temperature">Temperature</option>\n              <option value="leak">Leak</option>\n              <option value="zigbee">Zigbee</option>' "$DEVICEFORM"
  echo "  Patched DeviceForm.jsx (added temperature/leak/zigbee type options)"
fi

# Patch index.jsx — also clear type to empty if falsy (not just "unknown"),
# so auto-detected types like "contact"/"motion" pass through to the form.
DEVICESIDX="${DASHBOARD_DIR}/frontend/src/pages/devices/index.jsx"
if [ -f "$DEVICESIDX" ]; then
  sed -i 's/type: device\.type === "unknown" ? "" : device\.type/type: device.type === "unknown" || !device.type ? "" : device.type/' "$DEVICESIDX"
  echo "  Patched index.jsx (type pre-selection for auto-detected types)"
fi

echo "  Building React frontend (this may take a minute on Pi)..."
npm run build
echo "  Frontend built → ${DASHBOARD_DIR}/frontend/dist/ (${ENV_LABEL})"

# Start with PM2
pm2 delete pi-dashboard 2>/dev/null || true
cd "${DASHBOARD_DIR}/backend"
pm2 start server.js --name pi-dashboard --cwd "${DASHBOARD_DIR}/backend"
check_pm2_health "pi-dashboard"
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
# 8. CLOUDFLARE NAMED TUNNEL (Camera streaming — Pi → Cloudflare Edge)
# ================================================================
# Replaces the old autossh reverse SSH tunnel. Cloudflare Tunnel provides
# authenticated, encrypted access without SSH keys or open ports on EC2.
#
# How it works:
#   1. A named tunnel is created ONCE on Cloudflare Zero Trust dashboard
#   2. The tunnel token (eyJ...) is passed to this script
#   3. cloudflared connects to Cloudflare's edge and routes traffic to localhost:1984
#   4. The public hostname (e.g., hub1-qa.awesomliving.com) is set in the dashboard
#   5. The script registers the tunnel URL with server.js → hub-config.json
#   6. Hub heartbeat sends the tunnel URL to the backend automatically
#
# Token sources (priority order):
#   1. Hardcoded below (both PROD and QA tokens embedded since v23)
#   2. CF_TUNNEL_TOKEN env var override
#   3. ~/.cloudflare-tunnel-token file on the Pi
#   4. Skip (prints instructions for manual setup)
#
# Manual commands (if you need to set up the tunnel outside this script):
#   PROD:
#     sudo cloudflared service install eyJhIjoiNTBiNjRjMjhjOTgwNzVlMzIyODFlODMxNTNmOGZmM2QiLCJ0IjoiYmY2MTNkYzAtMjI3MS00YjE1LWEwMzItNDI1MzhhZDljZTI3IiwicyI6ImE4TWZXcmFLcmsrWUhud2ZIMVRUYW5jbmlLaWRSdWNzVmZVN3NsZkhjaFE9In0=
#     cloudflared tunnel run --token eyJhIjoiNTBiNjRjMjhjOTgwNzVlMzIyODFlODMxNTNmOGZmM2QiLCJ0IjoiYmY2MTNkYzAtMjI3MS00YjE1LWEwMzItNDI1MzhhZDljZTI3IiwicyI6ImE4TWZXcmFLcmsrWUhud2ZIMVRUYW5jbmlLaWRSdWNzVmZVN3NsZkhjaFE9In0=
#   QA:
#     sudo cloudflared service install eyJhIjoiNTBiNjRjMjhjOTgwNzVlMzIyODFlODMxNTNmOGZmM2QiLCJ0IjoiYTEwNWU0OTYtYWIyNi00NGYyLThhN2MtZTc4MzM5NjNmZTE1IiwicyI6Ik9EZG1NRFU1T0RFdFltRTRZaTAwTVROa0xXRXhPVGt0TmpCbFptSTJOR1ZsWVdJdyJ9
#     cloudflared tunnel run --token eyJhIjoiNTBiNjRjMjhjOTgwNzVlMzIyODFlODMxNTNmOGZmM2QiLCJ0IjoiYTEwNWU0OTYtYWIyNi00NGYyLThhN2MtZTc4MzM5NjNmZTE1IiwicyI6Ik9EZG1NRFU1T0RFdFltRTRZaTAwTVROa0xXRXhPVGt0TmpCbFptSTJOR1ZsWVdJdyJ9
echo ""
echo "[8/9] Setting up Cloudflare tunnel for camera streaming..."

# ── Install cloudflared ──────────────────────────────────────────────
if ! command -v cloudflared &>/dev/null; then
    echo "  Installing cloudflared..."
    ARCH=$(uname -m)
    if [[ "$ARCH" == "aarch64" ]]; then
        CF_PKG="cloudflared-linux-arm64.deb"
    elif [[ "$ARCH" == "armv7l" ]] || [[ "$ARCH" == "armhf" ]]; then
        CF_PKG="cloudflared-linux-arm.deb"
    else
        CF_PKG="cloudflared-linux-amd64.deb"
    fi
    retry "cloudflared download" curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/${CF_PKG}" \
        -o /tmp/cloudflared.deb
    sudo dpkg -i /tmp/cloudflared.deb
    rm -f /tmp/cloudflared.deb
    echo "  cloudflared installed: $(cloudflared --version)"
else
    echo "  cloudflared already installed: $(cloudflared --version)"
fi

# ── Resolve tunnel token ────────────────────────────────────────────
if [ -z "$CLOUDFLARE_TUNNEL_TOKEN" ]; then
    TOKEN_FILE="${PI_HOME}/.cloudflare-tunnel-token"
    if [ -f "$TOKEN_FILE" ]; then
        CLOUDFLARE_TUNNEL_TOKEN=$(cat "$TOKEN_FILE" | tr -d '[:space:]')
        echo "  Tunnel token loaded from ${TOKEN_FILE}"
    fi
fi

# ── Configure and start tunnel ──────────────────────────────────────
if [ -n "$CLOUDFLARE_TUNNEL_TOKEN" ]; then
    # Remove any existing cloudflared service (handles re-runs cleanly)
    sudo cloudflared service uninstall 2>/dev/null || true
    sudo systemctl stop cloudflared 2>/dev/null || true

    # Install cloudflared as a systemd service using the tunnel token.
    # This creates /etc/systemd/system/cloudflared.service automatically.
    # The token embeds the tunnel ID, account tag, and secret — no separate
    # credentials file or interactive login needed.
    sudo cloudflared service install "$CLOUDFLARE_TUNNEL_TOKEN"

    # ── Create local config.yml with explicit ingress rules ─────────────
    # FIX (v23): Token-based cloudflared sometimes fails to pull ingress rules
    # from the Cloudflare dashboard, causing "No ingress rules" warnings and
    # HTTP 503 on the public hostname. Creating a local config.yml with explicit
    # ingress rules fixes this reliably for both prod and QA.
    sudo mkdir -p /etc/cloudflared
    sudo tee /etc/cloudflared/config.yml > /dev/null << CFEOF
# Awesom Living — cloudflared ingress rules
# Auto-generated by setup-pi-fresh.sh (v23)
# Routes ${TUNNEL_HOSTNAME} → go2rtc on localhost:1984
ingress:
  - hostname: ${TUNNEL_HOSTNAME}
    service: http://localhost:1984
  - service: http_status:404
CFEOF
    echo "  Created /etc/cloudflared/config.yml (${TUNNEL_HOSTNAME} → localhost:1984)"

    sudo systemctl daemon-reload
    sudo systemctl enable cloudflared
    sudo systemctl start cloudflared
    sleep 5
    check_service_health "cloudflared"
    echo "  Cloudflare tunnel service installed and started"

    # Verify tunnel has no ingress warnings
    if sudo journalctl -u cloudflared --no-pager -n 10 2>/dev/null | grep -qi "no ingress rules"; then
        echo "  ⚠ WARNING: cloudflared still reporting 'No ingress rules'"
        echo "    Restarting cloudflared to pick up config.yml..."
        sudo systemctl restart cloudflared
        sleep 5
        check_service_health "cloudflared"
    fi

    # Persist token for future script re-runs
    echo "$CLOUDFLARE_TUNNEL_TOKEN" > "${PI_HOME}/.cloudflare-tunnel-token"
    chmod 600 "${PI_HOME}/.cloudflare-tunnel-token"

    # ── Register tunnel URL with server.js ───────────────────────────
    # server.js has POST /api/hub/tunnel which stores tunnel_url in
    # hub-config.json. The hub heartbeat then sends it to the backend,
    # which uses it to build per-camera stream URLs for the mobile app.
    TUNNEL_URL="https://${TUNNEL_HOSTNAME}"
    echo "  Registering tunnel URL: ${TUNNEL_URL}"

    # Wait for server.js to be available (may still be starting from section 7)
    SERVER_READY=false
    for i in $(seq 1 15); do
        if curl -s http://localhost:4000/api/hub/status >/dev/null 2>&1; then
            SERVER_READY=true
            break
        fi
        sleep 2
    done

    if [ "$SERVER_READY" = true ]; then
        curl -s -X POST http://localhost:4000/api/hub/tunnel \
            -H "Content-Type: application/json" \
            -d "{\"tunnel_url\": \"${TUNNEL_URL}\"}" >/dev/null 2>&1 && \
            echo "  Tunnel URL registered with hub server" || \
            echo "  WARNING: Tunnel URL registration failed (will retry on next heartbeat)"
    else
        echo "  WARNING: server.js not ready — tunnel URL will be registered on next boot"
        echo "  You can register manually: curl -X POST http://localhost:4000/api/hub/tunnel \\"
        echo "    -H 'Content-Type: application/json' -d '{\"tunnel_url\": \"${TUNNEL_URL}\"}'"
    fi

    echo ""
    echo "  ┌──────────────────────────────────────────────────────────┐"
    echo "  │  Cloudflare tunnel active                                │"
    echo "  │  Streams at: ${TUNNEL_URL}"
    printf "  │  %-57s│\n" ""
    echo "  │  go2rtc UI:  ${TUNNEL_URL}/api/streams                   │"
    echo "  └──────────────────────────────────────────────────────────┘"
else
    echo ""
    echo "  ┌─────────────────────────────────────────────────────────────────┐"
    echo "  │  No Cloudflare tunnel token found. Camera streaming skipped.   │"
    echo "  │                                                                 │"
    echo "  │  To enable camera streaming via Cloudflare named tunnel:        │"
    echo "  │  1. Go to Cloudflare Zero Trust → Networks → Tunnels            │"
    echo "  │  2. Create a tunnel (e.g., 'awesomliving-qa-hub1')              │"
    echo "  │  3. Add Public Hostname:                                        │"
    echo "  │       Subdomain: hub1-qa   Domain: awesomliving.com             │"
    echo "  │       Type: HTTP   URL: localhost:1984                           │"
    echo "  │  4. Copy the tunnel token (eyJ...)                              │"
    echo "  │  5. Re-run setup with the token:                                │"
    echo "  │     CF_TUNNEL_TOKEN=eyJ... ./setup-pi-fresh.sh --qa             │"
    echo "  │  Or save the token on the Pi first:                             │"
    echo "  │     echo 'eyJ...' > ~/.cloudflare-tunnel-token                  │"
    echo "  └─────────────────────────────────────────────────────────────────┘"
    echo ""
fi

# ── Disable legacy autossh tunnel if present ─────────────────────────
if systemctl is-enabled camera-tunnel 2>/dev/null | grep -q "enabled"; then
    echo "  Disabling legacy autossh camera-tunnel service..."
    sudo systemctl stop camera-tunnel 2>/dev/null || true
    sudo systemctl disable camera-tunnel 2>/dev/null || true
    echo "  Legacy tunnel disabled (replaced by Cloudflare)"
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
# Both envs now use Cloudflare named tunnels (v23+)
SERVICES_TO_CHECK="go2rtc mosquitto glk-bridge cloudflared"
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
echo "  Awesom Living Pi Setup Complete! (v26 - ${ENV_LABEL})"
echo "============================================"
echo ""
echo "  Pi IP:          ${PI_IP}"
if [ "$STATIC_IP_CONFIGURED" = true ]; then
  echo "  Static IP:      ${STATIC_IP} (configured)"
else
  echo "  Static IP:      NOT configured (manual setup needed)"
fi
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
TUNNEL_STATUS=$(systemctl is-active cloudflared 2>/dev/null || echo "inactive")
TUNNEL_LABEL="Cloudflare"
echo "    Pi Dashboard:  http://${PI_IP}:4000  (${DASH_STATUS})"
echo "    go2rtc:        http://${PI_IP}:1984  (${GO2RTC_STATUS})"
echo "    Zigbee2MQTT:   http://${PI_IP}:8080  (${Z2M_STATUS})"
echo "    Mosquitto:     localhost:1883         (${MOSQ_STATUS})"
echo "    GLK bridge:    localhost:8766         (${GLK_STATUS})"
echo "    Hub heartbeat: every 30s -> backend   (via Pi Dashboard server.js)"
echo "    ${TUNNEL_LABEL}:$(printf '%*s' $((15 - ${#TUNNEL_LABEL})) '')  (${TUNNEL_STATUS})"
echo ""
echo "  PM2 processes (will auto-restart on reboot):"
pm2 list 2>/dev/null || true
PM2_SVC_STATUS=$(systemctl is-enabled pm2-${PI_USER} 2>/dev/null || echo "not found")
echo "  PM2 boot service (pm2-${PI_USER}): ${PM2_SVC_STATUS}"
echo ""
if [ "$DEPLOY_ENV" = "qa" ]; then
  echo "  QA Backend:  https://qa.awesomliving.com"
  echo "  QA Admin:    https://qa.awesomliving.com/admin"
else
  echo "  Production:"
  echo "    Backend:   https://awesomliving.com"
  echo "    Camera:    https://p1.awesomliving.com"
fi
echo ""
echo "  Quick commands:"
echo "    Check tunnel:     sudo systemctl status cloudflared"
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
echo "  Manual tunnel setup (if needed outside this script):"
if [ "$DEPLOY_ENV" = "qa" ]; then
  echo "    sudo cloudflared service install eyJhIjoiNTBiNjRjMjhjOTgwNzVlMzIyODFlODMxNTNmOGZmM2QiLCJ0IjoiYTEwNWU0OTYtYWIyNi00NGYyLThhN2MtZTc4MzM5NjNmZTE1IiwicyI6Ik9EZG1NRFU1T0RFdFltRTRZaTAwTVROa0xXRXhPVGt0TmpCbFptSTJOR1ZsWVdJdyJ9"
else
  echo "    sudo cloudflared service install eyJhIjoiNTBiNjRjMjhjOTgwNzVlMzIyODFlODMxNTNmOGZmM2QiLCJ0IjoiYmY2MTNkYzAtMjI3MS00YjE1LWEwMzItNDI1MzhhZDljZTI3IiwicyI6ImE4TWZXcmFLcmsrWUhud2ZIMVRUYW5jbmlLaWRSdWNzVmZVN3NsZkhjaFE9In0="
fi
echo "    sudo systemctl enable cloudflared && sudo systemctl start cloudflared"
echo ""
echo "  Update dashboard later:"
echo "    cd ${REPO_DIR} && git pull origin ${REPO_BRANCH}"
echo "    cd frontend && npm install && npm run build"
echo "    pm2 restart pi-dashboard"
echo ""
echo "  Flow: Login → Hub Setup (first time) → Devices dashboard"
echo "============================================"

# ── Reboot prompt if static IP changed ───────────────────────────────────
if [ "$STATIC_IP_CONFIGURED" = true ] && [ "$CURRENT_IP" != "$STATIC_IP" ]; then
  echo ""
  echo "  *** REBOOT RECOMMENDED ***"
  echo "  Static IP changed: ${CURRENT_IP:-DHCP} -> ${STATIC_IP}"
  echo "  The Pi needs a reboot for the new IP to take effect."
  echo "  After reboot, reconnect at: ssh pi@${STATIC_IP}"
  echo ""
  read -p "  Reboot now? (y/N): " REBOOT_ANSWER
  if [[ "$REBOOT_ANSWER" =~ ^[Yy]$ ]]; then
    echo "  Rebooting in 3 seconds..."
    sleep 3
    sudo reboot
  else
    echo "  Skipped. Reboot manually when ready: sudo reboot"
  fi
fi

# Explicit success exit — prevents wrapper scripts from reporting false failures
exit 0
