#!/bin/bash
# ==============================================================================
# HeartBeatz Bootstrap — One-shot setup for a fresh MeLE N100
# ==============================================================================
#
# This single script takes a fresh Ubuntu 22.04 Server install and turns it
# into a fully working HeartBeatz demo box. Run it once, reboot, done.
#
# What it does (in order):
#   1. System update + essential packages
#   2. Docker Engine install (official repo, not snap)
#   3. Node.js 20 LTS install
#   4. HeartBeatz user + directory setup
#   5. Network config (static IP 192.168.1.10 for GL.iNet router)
#   6. GL.iNet router WiFi pre-config (HeartBeatz SSID)
#   7. Pull Docker images
#   8. Install HeartBeatz server + UI
#   9. Kiosk auto-boot (Xorg + Chromium fullscreen)
#  10. First-boot verification
#
# Usage:
#   # From your laptop, copy HeartBeatz folder to USB stick, then on MeLE:
#   sudo bash /media/<user>/USB/HeartBeatz/system/bootstrap.sh
#
#   # Or clone from the MeLE directly if it has internet:
#   sudo bash bootstrap.sh
#
# ==============================================================================

set -euo pipefail

# ---- Colors for output ----
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; }

# ---- Check prerequisites ----
if [ "$EUID" -ne 0 ]; then
  error "Please run as root: sudo bash bootstrap.sh"
  exit 1
fi

# Where are we? (to find the HeartBeatz project files)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

if [ ! -f "$PROJECT_DIR/docker-compose.yml" ]; then
  error "Cannot find HeartBeatz project files at $PROJECT_DIR"
  error "Expected docker-compose.yml in parent of this script's directory"
  exit 1
fi

info "HeartBeatz project found at: $PROJECT_DIR"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║        HeartBeatz Bootstrap Installer                ║"
echo "║        MeLE N100 → Demo Box in ~10 minutes          ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ===========================================================================
# STEP 1: System Update
# ===========================================================================
info "[1/10] Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq > /dev/null 2>&1
apt-get install -y -qq \
  curl \
  wget \
  git \
  unzip \
  ca-certificates \
  gnupg \
  lsb-release \
  net-tools \
  ufw \
  > /dev/null 2>&1
info "System packages updated"

# ===========================================================================
# STEP 2: Docker Engine (official repo — NOT the snap version)
# ===========================================================================
info "[2/10] Installing Docker Engine..."

if command -v docker &> /dev/null; then
  info "Docker already installed: $(docker --version)"
else
  # Add Docker's official GPG key
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
    gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg

  # Add the repository
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/ubuntu \
    $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list

  apt-get update -qq
  apt-get install -y -qq \
    docker-ce \
    docker-ce-cli \
    containerd.io \
    docker-buildx-plugin \
    docker-compose-plugin \
    > /dev/null 2>&1

  systemctl enable docker
  systemctl start docker
  info "Docker installed: $(docker --version)"
fi

# ===========================================================================
# STEP 3: Node.js 20 LTS
# ===========================================================================
info "[3/10] Installing Node.js 20 LTS..."

if command -v node &> /dev/null && node --version | grep -q "v20"; then
  info "Node.js already installed: $(node --version)"
else
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
  apt-get install -y -qq nodejs > /dev/null 2>&1
  info "Node.js installed: $(node --version)"
fi

# ===========================================================================
# STEP 4: HeartBeatz User + Directory
# ===========================================================================
HEARTBEATZ_USER="heartbeatz"
HEARTBEATZ_HOME="/home/${HEARTBEATZ_USER}"
INSTALL_DIR="/opt/heartbeatz"

info "[4/10] Setting up HeartBeatz user and directories..."

if ! id "$HEARTBEATZ_USER" &>/dev/null; then
  useradd -m -s /bin/bash "$HEARTBEATZ_USER"
  info "Created user: $HEARTBEATZ_USER"
else
  info "User $HEARTBEATZ_USER already exists"
fi

# Add to docker group so containers run without sudo
usermod -aG docker "$HEARTBEATZ_USER" 2>/dev/null || true

# Create install directory and copy project files
mkdir -p "$INSTALL_DIR"
cp -r "$PROJECT_DIR"/* "$INSTALL_DIR/"
chown -R "$HEARTBEATZ_USER:$HEARTBEATZ_USER" "$INSTALL_DIR"

# Create data directory for persistent state
mkdir -p "$INSTALL_DIR/data"
chown "$HEARTBEATZ_USER:$HEARTBEATZ_USER" "$INSTALL_DIR/data"

info "Project installed to $INSTALL_DIR"

# ===========================================================================
# STEP 5: Network Configuration
# ===========================================================================
info "[5/10] Configuring network (static IP 192.168.1.10)..."

ETH_IFACE=$(ip -o link show | awk -F': ' '{print $2}' | grep -E '^(enp|eth)' | head -1)

if [ -z "$ETH_IFACE" ]; then
  warn "No ethernet interface found — skipping static IP"
  warn "You'll need to configure networking manually"
else
  # Back up existing netplan
  cp /etc/netplan/*.yaml /etc/netplan/backup/ 2>/dev/null || true
  mkdir -p /etc/netplan/backup 2>/dev/null || true

  cat > /etc/netplan/01-heartbeatz.yaml << NETPLAN
# HeartBeatz network — static IP on GL.iNet MT3000 router network
network:
  version: 2
  renderer: networkd
  ethernets:
    ${ETH_IFACE}:
      addresses:
        - 192.168.1.10/24
      routes:
        - to: default
          via: 192.168.1.1
      nameservers:
        addresses:
          - 192.168.1.1
          - 8.8.8.8
      dhcp4: false
NETPLAN

  # Don't apply now (might kill SSH) — will take effect on reboot
  info "Network configured: ${ETH_IFACE} → 192.168.1.10 (applied on reboot)"
fi

# Firewall
if command -v ufw &> /dev/null; then
  ufw --force enable > /dev/null 2>&1
  ufw allow ssh > /dev/null 2>&1
  ufw allow 3000/tcp > /dev/null 2>&1  # Sensing REST
  ufw allow 3001/tcp > /dev/null 2>&1  # Sensing WS
  ufw allow 5005/udp > /dev/null 2>&1  # CSI UDP
  ufw allow 8080/tcp > /dev/null 2>&1  # HeartBeatz UI
  info "Firewall configured (SSH + HeartBeatz ports open)"
fi

# ===========================================================================
# STEP 6: GL.iNet Router WiFi Config Reminder
# ===========================================================================
info "[6/10] Router WiFi setup..."
echo ""
echo "  ┌─────────────────────────────────────────────────────────┐"
echo "  │  MANUAL STEP: Configure your GL.iNet MT3000 router     │"
echo "  │                                                         │"
echo "  │  1. Connect to router admin: http://192.168.1.1         │"
echo "  │  2. Set WiFi SSID:     HeartBeatz                       │"
echo "  │  3. Set WiFi Password: heartbeatz2026                   │"
echo "  │  4. Set WiFi Channel:  6 (fixed, not auto)              │"
echo "  │  5. Disable DHCP range conflict with .10                │"
echo "  │                                                         │"
echo "  │  The ESP32 nodes are pre-configured to connect to       │"
echo "  │  this SSID automatically.                               │"
echo "  └─────────────────────────────────────────────────────────┘"
echo ""

# ===========================================================================
# STEP 7: Pull Docker Images
# ===========================================================================
info "[7/10] Pulling Docker images (this may take a few minutes)..."

cd "$INSTALL_DIR"

# Pull the pre-built sensing server image
docker pull ruvnet/wifi-densepose:latest 2>&1 | tail -3 || {
  warn "Could not pull sensing server image"
  warn "Will build locally on first 'docker compose up'"
}

# ===========================================================================
# STEP 8: Install HeartBeatz Node.js Server
# ===========================================================================
info "[8/10] Installing HeartBeatz server dependencies..."

cd "$INSTALL_DIR/server"
sudo -u "$HEARTBEATZ_USER" npm ci --omit=dev > /dev/null 2>&1 || \
sudo -u "$HEARTBEATZ_USER" npm install --omit=dev > /dev/null 2>&1
info "Node.js dependencies installed"

# Build HeartBeatz Docker image
cd "$INSTALL_DIR"
docker compose build heartbeatz 2>&1 | tail -3 || {
  warn "Docker build had issues — check with: docker compose build"
}

# ===========================================================================
# STEP 9: Kiosk Auto-Boot Setup
# ===========================================================================
info "[9/10] Setting up kiosk auto-boot..."

# Install X11 + Chromium (minimal — no desktop environment)
apt-get install -y -qq \
  xorg \
  chromium-browser \
  unclutter \
  xdotool \
  > /dev/null 2>&1

# Write kiosk launcher
cat > "${INSTALL_DIR}/kiosk.sh" << 'KIOSK_SCRIPT'
#!/bin/bash
# HeartBeatz Kiosk Launcher — runs inside X session

set -euo pipefail

LOGFILE="/var/log/heartbeatz-kiosk.log"
HEALTH_URL="http://localhost:8080/api/health"
KIOSK_URL="http://localhost:8080"
MAX_WAIT=120

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOGFILE"; }

log "=== HeartBeatz Kiosk Starting ==="

# Start Docker containers
log "Starting Docker containers..."
cd /opt/heartbeatz
docker compose up -d 2>&1 | tee -a "$LOGFILE"

# Wait for HeartBeatz server to be ready
log "Waiting for server at ${HEALTH_URL}..."
elapsed=0
while [ $elapsed -lt $MAX_WAIT ]; do
  if curl -sf "${HEALTH_URL}" > /dev/null 2>&1; then
    log "Server ready (${elapsed}s)"
    break
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done

if [ $elapsed -ge $MAX_WAIT ]; then
  log "WARNING: Server not ready after ${MAX_WAIT}s, launching browser anyway"
fi

# Configure display
export DISPLAY=:0
unclutter -idle 3 -root &
xset s off
xset -dpms
xset s noblank

# Clear Chromium crash flags
CHROME_DIR="${HOME}/.config/chromium"
mkdir -p "${CHROME_DIR}/Default"
sed -i 's/"exited_cleanly":false/"exited_cleanly":true/' \
  "${CHROME_DIR}/Default/Preferences" 2>/dev/null || true
sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/' \
  "${CHROME_DIR}/Default/Preferences" 2>/dev/null || true

# Launch Chromium kiosk
log "Launching Chromium at ${KIOSK_URL}"
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

# Write X11 wrapper
cat > "${INSTALL_DIR}/start-kiosk.sh" << 'X11_WRAPPER'
#!/bin/bash
export HOME="/home/heartbeatz"
exec xinit /opt/heartbeatz/kiosk.sh -- :0 -nolisten tcp -nocursor vt7
X11_WRAPPER
chmod +x "${INSTALL_DIR}/start-kiosk.sh"

# Create systemd service
cat > "/etc/systemd/system/heartbeatz-kiosk.service" << SYSTEMD
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
TimeoutStartSec=180
Environment=HOME=${HEARTBEATZ_HOME}

[Install]
WantedBy=multi-user.target
SYSTEMD

# Disable any existing display manager
systemctl disable gdm3 2>/dev/null || true
systemctl disable lightdm 2>/dev/null || true
systemctl disable sddm 2>/dev/null || true

# Enable kiosk service
systemctl daemon-reload
systemctl enable heartbeatz-kiosk.service

info "Kiosk service installed and enabled"

# ===========================================================================
# STEP 10: Verification
# ===========================================================================
info "[10/10] Verifying installation..."

echo ""
echo "  Checking components:"
check() {
  if $1 > /dev/null 2>&1; then
    echo -e "    ${GREEN}✓${NC} $2"
  else
    echo -e "    ${RED}✗${NC} $2"
  fi
}

check "docker --version" "Docker $(docker --version 2>/dev/null | cut -d' ' -f3)"
check "docker compose version" "Docker Compose $(docker compose version 2>/dev/null | cut -d' ' -f4)"
check "node --version" "Node.js $(node --version 2>/dev/null)"
check "chromium-browser --version" "Chromium $(chromium-browser --version 2>/dev/null | cut -d' ' -f2)"
check "test -f ${INSTALL_DIR}/docker-compose.yml" "HeartBeatz project files"
check "test -f ${INSTALL_DIR}/server/node_modules/.package-lock.json" "Node.js dependencies"
check "systemctl is-enabled heartbeatz-kiosk" "Kiosk service enabled"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║              Installation Complete!                  ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║                                                      ║"
echo "║  1. Connect HDMI cable to IHANFO 7\" display         ║"
echo "║  2. Connect Ethernet to GL.iNet MT3000 router        ║"
echo "║  3. Configure router WiFi (see step 6 above)         ║"
echo "║  4. Reboot:  sudo reboot                             ║"
echo "║                                                      ║"
echo "║  After reboot, HeartBeatz starts automatically.      ║"
echo "║                                                      ║"
echo "║  Troubleshooting:                                    ║"
echo "║    journalctl -u heartbeatz-kiosk -f                 ║"
echo "║    docker compose -f /opt/heartbeatz/docker-compose.yml logs  ║"
echo "║                                                      ║"
echo "║  SSH access (from another device on the network):    ║"
echo "║    ssh heartbeatz@192.168.1.10                       ║"
echo "║                                                      ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
