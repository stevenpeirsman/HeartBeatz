#!/bin/bash
# ==============================================================================
# HeartBeatz Kiosk Setup — Run once on MeLE N100 to configure auto-boot
# ==============================================================================
#
# This script configures the MeLE N100 mini PC to:
#   1. Auto-login to the 'heartbeatz' user on boot
#   2. Start Docker containers (sensing-server)
#   3. Launch Chromium in fullscreen kiosk mode on the VoCore display
#
# Prerequisites:
#   - Ubuntu 22.04 installed on MeLE
#   - Docker + docker-compose installed
#   - Chromium browser installed
#   - VoCore display connected via USB-C
#
# Usage:
#   sudo bash install-kiosk.sh
#
# ==============================================================================

set -euo pipefail

HEARTBEATZ_USER="heartbeatz"
HEARTBEATZ_HOME="/home/${HEARTBEATZ_USER}"
INSTALL_DIR="/opt/heartbeatz"
SERVICE_NAME="heartbeatz-kiosk"

echo "================================================"
echo "  HeartBeatz Kiosk Installer"
echo "================================================"
echo ""

# --- Check prerequisites ---
if [ "$EUID" -ne 0 ]; then
  echo "ERROR: Please run as root (sudo bash install-kiosk.sh)"
  exit 1
fi

# --- Create user if needed ---
if ! id "$HEARTBEATZ_USER" &>/dev/null; then
  echo "[1/6] Creating user '$HEARTBEATZ_USER'..."
  useradd -m -s /bin/bash "$HEARTBEATZ_USER"
  usermod -aG docker "$HEARTBEATZ_USER"
else
  echo "[1/6] User '$HEARTBEATZ_USER' already exists"
  usermod -aG docker "$HEARTBEATZ_USER" 2>/dev/null || true
fi

# --- Install packages ---
echo "[2/6] Installing required packages..."
apt-get update -qq
apt-get install -y -qq \
  xorg \
  chromium-browser \
  unclutter \
  xdotool \
  docker.io \
  docker-compose \
  > /dev/null 2>&1

# --- Create install directory ---
echo "[3/6] Setting up ${INSTALL_DIR}..."
mkdir -p "${INSTALL_DIR}"

# --- Write the kiosk launcher script ---
cat > "${INSTALL_DIR}/kiosk.sh" << 'KIOSK_SCRIPT'
#!/bin/bash
# HeartBeatz Kiosk Launcher
# Runs as 'heartbeatz' user via systemd

set -euo pipefail

LOGFILE="/var/log/heartbeatz-kiosk.log"
DOCKER_DIR="/opt/heartbeatz/docker"
HEALTH_URL="http://localhost:3000/health"
KIOSK_URL="http://localhost:3000/setup"
MAX_HEALTH_WAIT=120  # seconds to wait for server

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOGFILE"; }

log "=== HeartBeatz Kiosk Starting ==="

# --- Step 1: Start Docker containers ---
log "Starting Docker containers..."
if [ -f "${DOCKER_DIR}/docker-compose.yml" ]; then
  cd "${DOCKER_DIR}"
  docker compose up -d 2>&1 | tee -a "$LOGFILE"
else
  log "WARNING: docker-compose.yml not found at ${DOCKER_DIR}"
  log "Assuming containers are managed separately"
fi

# --- Step 2: Wait for sensing server health check ---
log "Waiting for sensing server at ${HEALTH_URL}..."
elapsed=0
while [ $elapsed -lt $MAX_HEALTH_WAIT ]; do
  if curl -sf "${HEALTH_URL}" > /dev/null 2>&1; then
    log "Sensing server is ready (took ${elapsed}s)"
    break
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done

if [ $elapsed -ge $MAX_HEALTH_WAIT ]; then
  log "WARNING: Server not ready after ${MAX_HEALTH_WAIT}s, launching browser anyway"
fi

# --- Step 3: Configure display ---
# IHANFO 7" IPS display connected via HDMI
# 1024x600 @ 60Hz, no special drivers needed (native HDMI)
export DISPLAY=:0

# --- Step 4: Launch Chromium in kiosk mode ---
log "Launching Chromium kiosk at ${KIOSK_URL}..."

# Hide mouse cursor after 3 seconds of inactivity
unclutter -idle 3 -root &

# Disable screen blanking / power saving
xset s off
xset -dpms
xset s noblank

# Clear any prior Chromium crash flags
CHROME_DIR="${HOME}/.config/chromium"
mkdir -p "${CHROME_DIR}/Default"
sed -i 's/"exited_cleanly":false/"exited_cleanly":true/' \
  "${CHROME_DIR}/Default/Preferences" 2>/dev/null || true
sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/' \
  "${CHROME_DIR}/Default/Preferences" 2>/dev/null || true

# Launch Chromium
# --kiosk: fullscreen, no UI chrome
# --touch-events: enable touch support for VoCore
# --noerrdialogs: suppress error popups
# --disable-translate: no translation prompts
# --check-for-update-interval=31536000: disable update checks
# --no-first-run: skip welcome wizard
# --disable-pinch: prevent accidental zoom on touch
# --overscroll-history-navigation=0: prevent swipe-back navigation
exec chromium-browser \
  --kiosk \
  --touch-events=enabled \
  --noerrdialogs \
  --disable-translate \
  --no-first-run \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --check-for-update-interval=31536000 \
  --overscroll-history-navigation=0 \
  --autoplay-policy=no-user-gesture-required \
  --window-size=1024,600 \
  --window-position=0,0 \
  "${KIOSK_URL}"

KIOSK_SCRIPT
chmod +x "${INSTALL_DIR}/kiosk.sh"

# --- Write the X11 wrapper (starts X then kiosk) ---
cat > "${INSTALL_DIR}/start-kiosk.sh" << 'X11_WRAPPER'
#!/bin/bash
# Start minimal X server, then launch kiosk
# This is what systemd actually calls

export HOME="/home/heartbeatz"

# Start X on VoCore display
# Using xinit for minimal footprint (no desktop environment)
exec xinit /opt/heartbeatz/kiosk.sh -- :0 \
  -nolisten tcp \
  -nocursor \
  vt7
X11_WRAPPER
chmod +x "${INSTALL_DIR}/start-kiosk.sh"

# --- Write systemd service ---
echo "[4/6] Creating systemd service..."
cat > "/etc/systemd/system/${SERVICE_NAME}.service" << SYSTEMD_UNIT
[Unit]
Description=HeartBeatz Kiosk Display
After=network-online.target docker.service
Wants=network-online.target docker.service

[Service]
Type=simple
User=${HEARTBEATZ_USER}
Group=${HEARTBEATZ_USER}
ExecStart=${INSTALL_DIR}/start-kiosk.sh
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

# Give it time to start X + Chromium
TimeoutStartSec=180

# Environment
Environment=HOME=${HEARTBEATZ_HOME}

[Install]
WantedBy=multi-user.target
SYSTEMD_UNIT

# --- Configure auto-login (disable GUI login manager if present) ---
echo "[5/6] Configuring auto-login..."
# Disable GDM/LightDM if installed (we use our own X)
systemctl disable gdm3 2>/dev/null || true
systemctl disable lightdm 2>/dev/null || true
systemctl disable sddm 2>/dev/null || true

# --- Enable the kiosk service ---
echo "[6/6] Enabling kiosk service..."
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service"

echo ""
echo "================================================"
echo "  Installation complete!"
echo "================================================"
echo ""
echo "  Next steps:"
echo "    1. Copy your docker-compose.yml to ${INSTALL_DIR}/docker/"
echo "    2. Copy the HeartBeatz UI files to serve from the container"
echo "    3. Reboot to test: sudo reboot"
echo ""
echo "  Manage the kiosk:"
echo "    sudo systemctl status ${SERVICE_NAME}"
echo "    sudo systemctl restart ${SERVICE_NAME}"
echo "    sudo journalctl -u ${SERVICE_NAME} -f"
echo ""
echo "  To disable kiosk mode:"
echo "    sudo systemctl disable ${SERVICE_NAME}"
echo ""
