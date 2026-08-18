#!/usr/bin/env bash
# =============================================================================
# Awesom Living — Pi Dashboard QA Setup Automation
# =============================================================================
#
# Switches the Pi Dashboard to point at the QA backend (qa.awesomliving.com)
# instead of production (awesomliving.com).
#
# What this script does:
#   1. Backs up current prod configs
#   2. Patches frontend/src/constants/auth.js to read VITE_BACKEND_URL env var
#   3. Creates QA .env files for both backend and frontend
#   4. Rebuilds the frontend with QA env vars
#   5. Restarts PM2 processes
#
# Usage:
#   bash setup-qa-pi.sh          # Switch to QA mode
#   bash setup-qa-pi.sh --prod   # Switch back to Production mode
#
# Run on the Raspberry Pi:
#   scp setup-qa-pi.sh pi@<pi-ip>:~/
#   ssh pi@<pi-ip> "bash ~/setup-qa-pi.sh"
#
# =============================================================================

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
BACKEND_DIR="${DASHBOARD_DIR}/backend"
FRONTEND_DIR="${DASHBOARD_DIR}/frontend"
BACKUP_DIR="${PI_HOME}/awesomliving-qa-backup"

# ── QA or Production mode? ───────────────────────────────────────────────────
MODE="qa"
if [[ "${1:-}" == "--prod" || "${1:-}" == "--production" ]]; then
  MODE="prod"
fi

echo ""
echo "============================================"
echo "  Pi Dashboard — Switch to ${MODE^^} Mode"
echo "============================================"
echo ""

# ── Validate dashboard directory exists ──────────────────────────────────────
if [ ! -d "$DASHBOARD_DIR" ]; then
  err "Dashboard directory not found: $DASHBOARD_DIR"
  exit 1
fi

# ── Step 1: Backup current configs (only on first run) ───────────────────────
if [ ! -d "$BACKUP_DIR" ]; then
  info "Creating backup of current configs..."
  mkdir -p "$BACKUP_DIR"

  # Backup frontend auth constants
  if [ -f "$FRONTEND_DIR/src/constants/auth.js" ]; then
    cp "$FRONTEND_DIR/src/constants/auth.js" "$BACKUP_DIR/auth.js.prod"
    log "Backed up frontend auth.js"
  fi

  # Backup backend .env
  if [ -f "$BACKEND_DIR/.env" ]; then
    cp "$BACKEND_DIR/.env" "$BACKUP_DIR/backend.env.prod"
    log "Backed up backend .env"
  fi

  # Backup frontend .env (if exists)
  if [ -f "$FRONTEND_DIR/.env" ]; then
    cp "$FRONTEND_DIR/.env" "$BACKUP_DIR/frontend.env.prod"
    log "Backed up frontend .env"
  fi
else
  info "Backup already exists at $BACKUP_DIR"
fi

# ── Step 2: Apply config based on mode ───────────────────────────────────────

if [ "$MODE" == "qa" ]; then
  info "Switching to QA mode..."

  # Patch frontend auth.js to use env var (makes it switchable)
  cat > "$FRONTEND_DIR/src/constants/auth.js" << 'AUTHEOF'
export const AUTH_STORAGE_KEY = "zigbee-dashboard-authenticated";
// Configurable via VITE_BACKEND_URL at build time; defaults to production.
export const BASE_URL =
  import.meta.env.VITE_BACKEND_URL || "https://awesomliving.com/api";
AUTHEOF
  log "Patched frontend auth.js (now reads VITE_BACKEND_URL)"

  # Create QA .env for backend
  cat > "$BACKEND_DIR/.env" << 'BACKENDEOF'
REMOTE_BACKEND_URL=https://qa.awesomliving.com
GO2RTC_URL=http://localhost:1984
BACKENDEOF
  log "Created QA backend .env → qa.awesomliving.com"

  # Create QA .env for frontend (Vite reads VITE_* at build time)
  cat > "$FRONTEND_DIR/.env" << 'FRONTENDEOF'
VITE_BACKEND_URL=https://qa.awesomliving.com/api
FRONTENDEOF
  log "Created QA frontend .env → qa.awesomliving.com/api"

elif [ "$MODE" == "prod" ]; then
  info "Switching back to Production mode..."

  # Restore original auth.js
  if [ -f "$BACKUP_DIR/auth.js.prod" ]; then
    cp "$BACKUP_DIR/auth.js.prod" "$FRONTEND_DIR/src/constants/auth.js"
    log "Restored original auth.js"
  else
    # If no backup, write the known prod value
    cat > "$FRONTEND_DIR/src/constants/auth.js" << 'AUTHEOF'
export const AUTH_STORAGE_KEY = "zigbee-dashboard-authenticated";
export const BASE_URL =
  "https://awesomliving.com/api";
AUTHEOF
    log "Wrote production auth.js"
  fi

  # Restore backend .env
  if [ -f "$BACKUP_DIR/backend.env.prod" ]; then
    cp "$BACKUP_DIR/backend.env.prod" "$BACKEND_DIR/.env"
    log "Restored production backend .env"
  else
    # No .env needed for prod (defaults in code point to awesomliving.com)
    rm -f "$BACKEND_DIR/.env"
    log "Removed backend .env (uses code defaults)"
  fi

  # Remove frontend .env (prod values are hardcoded defaults)
  rm -f "$FRONTEND_DIR/.env"
  log "Removed frontend .env (uses code defaults)"
fi

# ── Step 3: Rebuild frontend ─────────────────────────────────────────────────
info "Rebuilding frontend..."
cd "$FRONTEND_DIR"

# Install deps if needed
if [ ! -d "node_modules" ]; then
  npm install
fi

npm run build
log "Frontend rebuilt with ${MODE^^} config"

# ── Step 4: Restart PM2 processes ────────────────────────────────────────────
info "Restarting PM2 processes..."

# Restart the Pi Dashboard backend
if pm2 list 2>/dev/null | grep -q "pi-dashboard\|pie-dashboard\|server"; then
  pm2 restart all
  log "PM2 processes restarted"
else
  warn "No PM2 process found — you may need to start it manually:"
  echo "  cd $BACKEND_DIR && pm2 start server.js --name pi-dashboard"
fi

# ── Step 5: Verify ───────────────────────────────────────────────────────────
echo ""
echo "============================================"
echo "  Pi Dashboard — ${MODE^^} Mode Active"
echo "============================================"
echo ""

if [ "$MODE" == "qa" ]; then
  echo "  Backend points to:  https://qa.awesomliving.com"
  echo "  Frontend API URL:   https://qa.awesomliving.com/api"
  echo ""
  echo "  To switch back to production:"
  echo "    bash ~/setup-qa-pi.sh --prod"
else
  echo "  Backend points to:  https://awesomliving.com"
  echo "  Frontend API URL:   https://awesomliving.com/api"
  echo ""
  echo "  To switch to QA:"
  echo "    bash ~/setup-qa-pi.sh"
fi

echo ""
pm2 list 2>/dev/null || true
echo ""
