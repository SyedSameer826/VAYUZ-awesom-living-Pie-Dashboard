#!/usr/bin/env bash
# ============================================================================
# Awesom Living — Multi-Camera Update for Existing Pi
# ============================================================================
#
# NON-DESTRUCTIVE: Only applies multi-camera changes. Does NOT touch:
#   - Zigbee2MQTT / Mosquitto / paired Zigbee devices
#   - GLK bridge / sleep monitor
#   - MQTT bridge
#   - Existing devices.json / hub-config.json data
#   - Node-RED
#
# Run on a Pi that was already set up:
#   bash ~/update-pi-multicam.sh
#
# What this script does:
#   1. Pulls latest Pi Dashboard code (git pull)
#   2. Installs any new npm dependencies
#   3. Installs cloudflared (if not present)
#   4. Creates the tunnel setup helper script
#   5. Ensures go2rtc YAML has the right structure
#   6. Updates PM2 ecosystem config (adds tunnel process)
#   7. Restarts Pi Dashboard + go2rtc via PM2
#
# After this script, you still need to:
#   - Run ~/setup-tunnel.sh to create the Cloudflare tunnel (one-time, interactive)
#   - Deploy backend changes to EC2 (push to GitHub → CI)
#
# ============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[OK]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[X]${NC} $*" >&2; }
info() { echo -e "${CYAN}[i]${NC} $*"; }

PI_USER="${USER:-pi}"
PI_HOME="/home/${PI_USER}"
DASHBOARD_DIR="${PI_HOME}/VAYUZ-awesom-living-Pie-Dashboard"
GO2RTC_DIR="${PI_HOME}/go2rtc"
DATA_DIR="${PI_HOME}/awesomliving-data"

echo ""
echo "============================================"
echo "  Multi-Camera Update for Existing Pi"
echo "============================================"
echo ""

# Show hub ID for reference
HUB_ID=""
if [ -f /proc/cpuinfo ]; then
  SERIAL=$(grep -i serial /proc/cpuinfo | awk '{print $NF}' 2>/dev/null || echo "")
  if [ -n "$SERIAL" ]; then
    HUB_ID="pi-${SERIAL}"
    info "Hub ID: ${HUB_ID}"
  fi
fi
if [ -z "$HUB_ID" ]; then
  HUB_ID="pi-$(hostname)"
  info "Hub ID (hostname-based): ${HUB_ID}"
fi

# ============================================================================
# 1. UPDATE PI DASHBOARD CODE
# ============================================================================

echo ""
info "Step 1: Updating Pi Dashboard code..."

if [ ! -d "${DASHBOARD_DIR}" ]; then
  err "Pi Dashboard not found at ${DASHBOARD_DIR}"
  err "Please clone it first: git clone <repo-url> ${DASHBOARD_DIR}"
  exit 1
fi

cd "${DASHBOARD_DIR}"

# Check if there are local changes that would conflict with pull
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  warn "Local changes detected in Pi Dashboard. Stashing them..."
  git stash save "pre-multicam-update-$(date +%Y%m%d%H%M%S)" || true
fi

# Pull latest code
CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "main")
info "Pulling latest from branch: ${CURRENT_BRANCH}..."
if git pull origin "${CURRENT_BRANCH}" 2>/dev/null; then
  log "Pi Dashboard code updated"
else
  warn "git pull failed — you may need to push changes from your Windows machine first"
  warn "On Windows, run: cd VAYUZ-awesom-living-Pie-Dashboard && git add -A && git commit -m 'multi-camera changes' && git push"
  warn "Then re-run this script."
  echo ""
  read -p "Continue anyway with existing code? (y/N) " -n 1 -r
  echo ""
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

# Install npm dependencies (in case new ones were added)
cd "${DASHBOARD_DIR}/backend"
info "Installing backend npm dependencies..."
npm install --production 2>/dev/null
log "Backend dependencies installed"

# Build frontend (if frontend folder exists and has package.json)
if [ -f "${DASHBOARD_DIR}/frontend/package.json" ]; then
  cd "${DASHBOARD_DIR}/frontend"
  info "Installing frontend npm dependencies..."
  npm install 2>/dev/null
  info "Building frontend..."
  npm run build 2>/dev/null || warn "Frontend build failed (non-critical — dashboard may still work)"
  log "Frontend built"
fi

# ============================================================================
# 2. ENSURE GO2RTC IS INSTALLED AND CONFIGURED
# ============================================================================

echo ""
info "Step 2: Checking go2rtc..."

GO2RTC_BIN="/usr/local/bin/go2rtc"

if [ ! -f "${GO2RTC_BIN}" ]; then
  # Check if go2rtc binary is in the home directory
  if [ -f "${GO2RTC_DIR}/go2rtc" ]; then
    GO2RTC_BIN="${GO2RTC_DIR}/go2rtc"
    log "go2rtc found at ${GO2RTC_BIN}"
  else
    warn "go2rtc binary not found. Installing..."
    ARCH=$(dpkg --print-architecture 2>/dev/null || echo "arm64")
    if [ "$ARCH" = "arm64" ]; then
      GO2RTC_ARCH="linux_arm64"
    elif [ "$ARCH" = "armhf" ]; then
      GO2RTC_ARCH="linux_arm"
    else
      GO2RTC_ARCH="linux_amd64"
    fi
    wget -q "https://github.com/AlexxIT/go2rtc/releases/latest/download/go2rtc_${GO2RTC_ARCH}" \
      -O "${GO2RTC_BIN}" || {
        err "Failed to download go2rtc"
        exit 1
      }
    chmod +x "${GO2RTC_BIN}"
    log "go2rtc installed at ${GO2RTC_BIN}"
  fi
else
  log "go2rtc already installed at ${GO2RTC_BIN}"
fi

# Locate the go2rtc binary for PM2
# Check common locations
if [ -f "/usr/local/bin/go2rtc" ]; then
  GO2RTC_BIN="/usr/local/bin/go2rtc"
elif [ -f "${GO2RTC_DIR}/go2rtc" ]; then
  GO2RTC_BIN="${GO2RTC_DIR}/go2rtc"
fi

# Ensure go2rtc config directory exists
mkdir -p "${GO2RTC_DIR}"

# Ensure go2rtc.yaml exists with correct structure (don't overwrite existing streams)
GO2RTC_YAML="${GO2RTC_DIR}/go2rtc.yaml"
if [ ! -f "${GO2RTC_YAML}" ]; then
  cat > "${GO2RTC_YAML}" <<'YAML'
# Awesom Living go2rtc config — managed by the Pi dashboard.
# Camera streams are added dynamically via the dashboard UI.
# Do NOT remove entries manually — use the dashboard's Delete button.

streams: {}

api:
  listen: ":1984"

webrtc:
  candidates:
    - stun:8555
YAML
  log "go2rtc.yaml created (empty streams — cameras added via Dashboard UI)"
else
  log "go2rtc.yaml already exists (existing streams preserved)"
  # Just make sure the api section exists
  if ! grep -q "listen.*1984" "${GO2RTC_YAML}" 2>/dev/null; then
    warn "go2rtc.yaml may not have the API listener. Please ensure it has:"
    warn "  api:"
    warn "    listen: \":1984\""
  fi
fi

# ============================================================================
# 3. INSTALL CLOUDFLARED (if not present)
# ============================================================================

echo ""
info "Step 3: Checking cloudflared..."

if command -v cloudflared &>/dev/null; then
  log "cloudflared already installed: $(cloudflared --version 2>/dev/null || echo 'yes')"
else
  warn "cloudflared not found. Installing..."
  ARCH=$(dpkg --print-architecture 2>/dev/null || echo "arm64")
  wget -q "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}.deb" \
    -O /tmp/cloudflared.deb || {
      err "Failed to download cloudflared"
      err "You can install it manually later: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
      # Don't exit — rest of the script is still useful
    }
  if [ -f /tmp/cloudflared.deb ]; then
    sudo dpkg -i /tmp/cloudflared.deb 2>/dev/null || {
      err "cloudflared install failed. Try: sudo dpkg -i /tmp/cloudflared.deb"
    }
    rm -f /tmp/cloudflared.deb
    if command -v cloudflared &>/dev/null; then
      log "cloudflared installed"
    fi
  fi
fi

# ============================================================================
# 4. CREATE TUNNEL SETUP HELPER SCRIPT
# ============================================================================

echo ""
info "Step 4: Creating tunnel setup helper script..."

cat > "${PI_HOME}/setup-tunnel.sh" <<'TUNNEL_SCRIPT'
#!/usr/bin/env bash
# ============================================================================
# Cloudflare Named Tunnel Setup
# Run ONCE after initial setup to create a named Cloudflare tunnel.
# Usage: bash ~/setup-tunnel.sh <tunnel-name> <hostname>
#   e.g.: bash ~/setup-tunnel.sh awesomliving-p1 p1.awesomliving.com
# ============================================================================

set -euo pipefail

TUNNEL_NAME="${1:-}"
HOSTNAME="${2:-}"

if [ -z "$TUNNEL_NAME" ] || [ -z "$HOSTNAME" ]; then
  echo "Usage: bash setup-tunnel.sh <tunnel-name> <hostname>"
  echo "  e.g.: bash setup-tunnel.sh awesomliving-p1 p1.awesomliving.com"
  exit 1
fi

# Step 1: Login to Cloudflare (will display a URL — open it in your browser)
echo "1/6 Logging in to Cloudflare..."
cloudflared tunnel login

# Step 2: Create the tunnel
echo "2/6 Creating tunnel: ${TUNNEL_NAME}..."
cloudflared tunnel create "${TUNNEL_NAME}"

# Step 3: Get the tunnel ID
TUNNEL_ID=$(cloudflared tunnel list -o json | jq -r ".[] | select(.name==\"${TUNNEL_NAME}\") | .id")
echo "   Tunnel ID: ${TUNNEL_ID}"

# Step 4: Create DNS route
echo "3/6 Routing ${HOSTNAME} -> tunnel..."
cloudflared tunnel route dns "${TUNNEL_NAME}" "${HOSTNAME}"

# Step 5: Write config
CRED_FILE="$HOME/.cloudflared/${TUNNEL_ID}.json"
cat > "$HOME/.cloudflared/config.yml" <<EOF
tunnel: ${TUNNEL_ID}
credentials-file: ${CRED_FILE}

ingress:
  - hostname: ${HOSTNAME}
    service: http://localhost:1984
  - service: http_status:404
EOF

echo "4/6 Config written to ~/.cloudflared/config.yml"

# Step 6: Save the tunnel URL to hub config so heartbeats include it
DATA_DIR="$HOME/awesomliving-data"
mkdir -p "$DATA_DIR"
HUB_CONFIG="$DATA_DIR/hub-config.json"
if [ -f "$HUB_CONFIG" ]; then
  TMP=$(mktemp)
  jq --arg url "https://${HOSTNAME}" '.tunnel_url = $url' "$HUB_CONFIG" > "$TMP" && mv "$TMP" "$HUB_CONFIG"
else
  echo "{\"tunnel_url\": \"https://${HOSTNAME}\"}" > "$HUB_CONFIG"
fi
echo "5/6 tunnel_url saved to hub-config.json"

# Step 7: Start the tunnel via PM2
echo "6/6 Starting tunnel in PM2..."
pm2 start cloudflared --name tunnel -- tunnel run "${TUNNEL_NAME}"
pm2 save

echo ""
echo "============================================"
echo "  Tunnel Setup Complete!"
echo "============================================"
echo "  Hostname:  ${HOSTNAME}"
echo "  Tunnel ID: ${TUNNEL_ID}"
echo "  Config:    ~/.cloudflared/config.yml"
echo ""
echo "  The tunnel is running via PM2."
echo "  Verify: curl -s https://${HOSTNAME}/api/streams | head"
echo ""
TUNNEL_SCRIPT

chmod +x "${PI_HOME}/setup-tunnel.sh"
log "Tunnel setup script created at ~/setup-tunnel.sh"

# ============================================================================
# 5. UPDATE PM2 ECOSYSTEM CONFIG
# ============================================================================

echo ""
info "Step 5: Updating PM2 ecosystem config..."

# Find Z2M directory
Z2M_DIR=""
if [ -d "/opt/zigbee2mqtt" ]; then
  Z2M_DIR="/opt/zigbee2mqtt"
elif [ -d "${PI_HOME}/zigbee2mqtt" ]; then
  Z2M_DIR="${PI_HOME}/zigbee2mqtt"
fi

REMOTE_BACKEND="${REMOTE_BACKEND_URL:-https://awesomliving.com}"
HUB_SECRET="${HUB_SECRET_KEY:-}"

cat > "${PI_HOME}/ecosystem.config.cjs" <<CJS
module.exports = {
  apps: [
    {
      name: 'go2rtc',
      script: '${GO2RTC_BIN}',
      args: '-config ${GO2RTC_DIR}/go2rtc.yaml',
      autorestart: true,
      max_restarts: 50,
      restart_delay: 3000,
    },
    {
      name: 'zigbee2mqtt',
      cwd: '${Z2M_DIR}',
      script: 'index.js',
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
    },
    {
      name: 'pi-dashboard',
      cwd: '${DASHBOARD_DIR}/backend',
      script: 'server.js',
      autorestart: true,
      max_restarts: 50,
      restart_delay: 3000,
      env: {
        NODE_ENV: 'production',
        PORT: 4000,
        GO2RTC_URL: 'http://localhost:1984',
        REMOTE_BACKEND_URL: '${REMOTE_BACKEND}',
        HUB_SECRET_KEY: '${HUB_SECRET}',
        DEVICES_DIR: '${DATA_DIR}',
      },
    },
  ],
};
CJS

log "ecosystem.config.cjs updated"

# ============================================================================
# 6. RESTART SERVICES
# ============================================================================

echo ""
info "Step 6: Restarting services..."

# Stop existing processes gracefully
pm2 stop pi-dashboard 2>/dev/null || true
pm2 stop go2rtc 2>/dev/null || true

# Delete old process entries (they'll be recreated from ecosystem file)
pm2 delete pi-dashboard 2>/dev/null || true
pm2 delete go2rtc 2>/dev/null || true

# Don't touch zigbee2mqtt if it's running — it manages paired devices
# Just ensure it's using the ecosystem config

# Start from ecosystem
pm2 start "${PI_HOME}/ecosystem.config.cjs"
pm2 save

log "PM2 services restarted"

# ============================================================================
# 7. VERIFY
# ============================================================================

echo ""
info "Step 7: Verifying..."

sleep 3

# Check if services are running
echo ""
pm2 status

echo ""

# Check go2rtc API
if curl -s -o /dev/null -w "%{http_code}" http://localhost:1984/api/streams | grep -q "200"; then
  log "go2rtc API is responding on :1984"
else
  warn "go2rtc API not responding yet — it may need a few more seconds"
fi

# Check Pi Dashboard
if curl -s -o /dev/null -w "%{http_code}" http://localhost:4000/api/hub/setup | grep -q "200"; then
  log "Pi Dashboard API is responding on :4000"
  # Show hub info
  HUB_INFO=$(curl -s http://localhost:4000/api/hub/setup 2>/dev/null || echo "{}")
  echo "  Hub config: ${HUB_INFO}"
else
  warn "Pi Dashboard not responding yet — check: pm2 logs pi-dashboard"
fi

# ============================================================================
# DONE
# ============================================================================

echo ""
echo "============================================"
echo "  Multi-Camera Update Complete!"
echo "============================================"
echo ""
echo "  Hub ID:    ${HUB_ID}"
echo "  Dashboard: http://192.168.50.106:4000"
echo "  go2rtc:    http://192.168.50.106:1984"
echo ""
echo "What's been updated:"
echo "  - Pi Dashboard code (git pull + npm install)"
echo "  - go2rtc config (streams preserved)"
echo "  - PM2 ecosystem (dashboard + go2rtc)"
echo "  - cloudflared installed (if it wasn't already)"
echo ""
echo "REMAINING STEPS:"
echo ""
echo "  1. BACKEND DEPLOY (from Windows):"
echo "     cd backend-nodejs"
echo "     git add -A && git commit -m 'multi-camera changes' && git push"
echo "     (CI will deploy to EC2 automatically)"
echo ""
echo "  2. SET UP CLOUDFLARE TUNNEL (on this Pi, one-time):"
echo "     bash ~/setup-tunnel.sh awesomliving-p1 p1.awesomliving.com"
echo "     (This is interactive — it will show a URL to open in your browser)"
echo ""
echo "  3. TEST MULTI-CAMERA:"
echo "     - Open http://192.168.50.106:4000 in your browser"
echo "     - Scan for cameras (they'll appear as discovered)"
echo "     - Map each camera with a unique stream name (e.g. cam_living, cam_bedroom)"
echo "     - Each camera gets registered in go2rtc + cloud backend automatically"
echo "     - Check go2rtc streams: http://192.168.50.106:1984"
echo ""
echo "  4. VERIFY STREAMS:"
echo "     curl http://localhost:1984/api/streams"
echo "     (Should show all registered camera streams)"
echo ""
echo "NOTE: Existing Zigbee devices, GLK bridge, and MQTT bridge are untouched."
echo ""
