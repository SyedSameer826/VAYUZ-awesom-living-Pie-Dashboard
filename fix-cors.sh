#!/usr/bin/env bash
# ============================================================================
# fix-cors.sh — Fix CORS error on Pi Dashboard login
# ============================================================================
# Run this ON THE PI (ssh pi@192.168.50.106, password: 1234):
#
#   Option A (from Windows with plink):
#     type fix-cors.sh | plink -ssh -pw 1234 pi@192.168.50.106 "cat > ~/fix-cors.sh && chmod +x ~/fix-cors.sh && ~/fix-cors.sh"
#
#   Option B (from Mac/Linux):
#     sshpass -p 1234 scp fix-cors.sh pi@192.168.50.106:~/fix-cors.sh
#     sshpass -p 1234 ssh pi@192.168.50.106 "chmod +x ~/fix-cors.sh && ~/fix-cors.sh"
#
# What it fixes:
#   The Pi Dashboard frontend (http://192.168.50.106:4000) calls the cloud
#   backend (https://awesomliving.com) directly from the browser. Browsers
#   block this cross-origin request (CORS policy). Fix: route all cloud API
#   calls through the Pi's own Express server, so the browser only talks to
#   its own origin. The Pi server proxies /api/user/* to the cloud backend.
# ============================================================================

set -e

DASHBOARD_DIR="/home/pi/pi-dashboard"

if [ ! -d "$DASHBOARD_DIR" ]; then
    echo "ERROR: Pi Dashboard not found at $DASHBOARD_DIR"
    exit 1
fi

# Read the cloud backend URL from the existing .env
REMOTE_URL=""
if [ -f "${DASHBOARD_DIR}/backend/.env" ]; then
    REMOTE_URL=$(grep "^REMOTE_BACKEND_URL=" "${DASHBOARD_DIR}/backend/.env" | cut -d= -f2-)
fi
if [ -z "$REMOTE_URL" ]; then
    REMOTE_URL="https://awesomliving.com"
fi
echo "Cloud backend: $REMOTE_URL"

# ── 1. Patch auth.js — use relative URL instead of absolute cloud URL ──
echo ""
echo "[1/5] Patching frontend auth.js (relative BASE_URL)..."
cat > "${DASHBOARD_DIR}/frontend/src/constants/auth.js" << 'AUTHEOF'
export const AUTH_STORAGE_KEY = "zigbee-dashboard-authenticated";
// Relative URL — Pi server.js proxies /api/user/* to cloud backend.
// This avoids CORS errors (browser blocks cross-origin fetch).
export const BASE_URL = "/api";
AUTHEOF
echo "  auth.js: BASE_URL = '/api' (was full cloud URL)"

# ── 2. Patch deviceService.js — use relative URL for getResidents ──
echo ""
echo "[2/5] Patching frontend deviceService.js (relative REMOTE_BACKEND)..."
DEVICE_SVC="${DASHBOARD_DIR}/frontend/src/services/deviceService.js"
if [ -f "$DEVICE_SVC" ]; then
    # Replace the REMOTE_BACKEND declaration (may be 1 or 2 lines)
    # First, check if it's the multi-line version with import.meta.env
    if grep -q "import.meta.env.VITE_BACKEND_URL" "$DEVICE_SVC"; then
        # Multi-line: "const REMOTE_BACKEND =\n  import.meta.env..."
        node -e "
const fs = require('fs');
let code = fs.readFileSync('$DEVICE_SVC', 'utf8');
code = code.replace(
    /const REMOTE_BACKEND\s*=\s*\n\s*import\.meta\.env\.VITE_BACKEND_URL\s*\|\|\s*[\"'][^\"']*[\"'];?/,
    'const REMOTE_BACKEND = \"\";'
);
fs.writeFileSync('$DEVICE_SVC', code);
"
        echo "  deviceService.js: REMOTE_BACKEND = '' (was import.meta.env...)"
    else
        echo "  deviceService.js: no VITE_BACKEND_URL reference found — skipping"
    fi
else
    echo "  WARNING: deviceService.js not found at $DEVICE_SVC"
fi

# ── 3. Patch server.js — add reverse proxy for cloud backend API ──
echo ""
echo "[3/5] Adding cloud API proxy to server.js..."
SRVJS="${DASHBOARD_DIR}/backend/server.js"
if grep -q "CLOUD BACKEND PROXY" "$SRVJS" 2>/dev/null; then
    echo "  server.js: cloud proxy already present — skipping"
else
    node -e "
const fs = require('fs');
let code = fs.readFileSync('$SRVJS', 'utf8');

const proxyBlock = \`
/* =========================
   CLOUD BACKEND PROXY
   The React frontend calls cloud backend endpoints (auth, residents, etc.)
   but browsers block cross-origin requests (CORS). We proxy /api/user/*
   through this Express server so all frontend requests stay same-origin.
========================= */

// NOTE: context filter as first arg (not Express mount path) so the full
// request path /api/user/... is preserved and proxied intact. If we used
// app.use('/api/user', createProxyMiddleware({...})), Express would strip
// the mount path and proxy to REMOTE_BACKEND/auth/sign-in (wrong).
app.use(
  createProxyMiddleware(\\\"/api/user\\\", {
    target: REMOTE_BACKEND,
    changeOrigin: true,
    logLevel: \\\"warn\\\",
  }),
);

\`;

// Insert BEFORE the 'SERVE REACT BUILD' section
const marker = '/* =========================\\n   SERVE REACT BUILD';
const idx = code.indexOf('SERVE REACT BUILD');
if (idx === -1) {
    console.log('  WARNING: could not find SERVE REACT BUILD marker');
    process.exit(1);
}
// Find the /* ===... line just above it
const blockStart = code.lastIndexOf('/* ====', idx);
if (blockStart === -1) {
    console.log('  WARNING: could not find section divider');
    process.exit(1);
}
code = code.slice(0, blockStart) + proxyBlock + code.slice(blockStart);
fs.writeFileSync('$SRVJS', code);
console.log('  server.js: added /api/user/* proxy -> ' + '$REMOTE_URL' + '/api/user/*');
"
fi

# ── 4. Rebuild frontend ──
echo ""
echo "[4/5] Rebuilding React frontend (takes ~1 min on Pi)..."
cd "${DASHBOARD_DIR}/frontend"
npm run build
echo "  Frontend rebuilt → ${DASHBOARD_DIR}/frontend/dist/"

# ── 5. Restart Pi Dashboard ──
echo ""
echo "[5/5] Restarting Pi Dashboard..."
pm2 restart pi-dashboard
sleep 2
pm2 status pi-dashboard

echo ""
echo "============================================"
echo "  CORS fix applied!"
echo "  Dashboard: http://192.168.50.106:4000"
echo "  Auth flow: browser → Pi proxy → ${REMOTE_URL}"
echo "============================================"
echo ""
echo "  Try logging in again at http://192.168.50.106:4000/login"
