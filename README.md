# HeartBeatz

**Portable WiFi CSI Sensing Demo Box** — presence detection, pose estimation, and vital signs monitoring using WiFi Channel State Information (CSI), BLE beacons, and mmWave radar.

HeartBeatz packages the [RuView](https://github.com/ruvnet/RuView) sensing platform into a self-contained, battery-powered appliance for client on-site demos. Power on, wait 30 seconds, and the 7" touchscreen walks you through node discovery and room calibration automatically.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  MAIN BOX (MeLE N100 Mini PC)                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Docker                                                     │  │
│  │  ┌─────────────────────┐  ┌────────────────────────────┐  │  │
│  │  │ sensing-server      │  │ heartbeatz                  │  │  │
│  │  │ (Rust/Axum)         │  │ (Node.js)                   │  │  │
│  │  │ :3000 REST          │◄─│ :8080 UI + API              │  │  │
│  │  │ :3001 WebSocket     │  │ - Node discovery             │  │  │
│  │  │ :5005 UDP ingest    │  │ - BLE beacon tracking        │  │  │
│  │  └─────────────────────┘  │ - LD2410S radar reader       │  │  │
│  │                            │ - WebSocket hub → UI         │  │  │
│  │                            └────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────┘  │
│  IHANFO 7" IPS Display (1024x600, Chromium Kiosk)              │
│  UGREEN 25,000mAh Power Bank                                   │
└────────────────────────┬────────────────────────────────────────┘
                         │ Ethernet (192.168.8.10)
              ┌──────────┴──────────┐
              │ GL.iNet MT3000      │
              │ Router (192.168.8.1)│
              │ SSID: HeartBeatz    │
              └──┬───┬───┬───┬─────┘
                 │   │   │   │  WiFi (192.168.8.x)
          ┌──────┘   │   │   └──────┐
          ▼          ▼   ▼          ▼
     ┌─────────┐┌─────────┐┌─────────┐┌─────────┐
     │ ESP32-S3││ ESP32-S3││ ESP32-S3││ ESP32-S3│
     │ Node 1  ││ Node 2  ││ Node 3  ││ Node 4  │
     │ + Radar ││ + Radar ││ + Radar ││ + Radar │
     │ + UPS   ││ + UPS   ││ + UPS   ││ + UPS   │
     └─────────┘└─────────┘└─────────┘└─────────┘
       CSI + radar data → UDP :5005 → sensing-server
```

## Hardware Bill of Materials

| Component | Model | Qty | Purpose |
|---|---|---|---|
| Mini PC | MeLE Quieter4C (N100, 16GB, 512GB) | 1 | Runs Docker, serves UI |
| Router | GL.iNet MT3000 (Beryl AX) | 1 | Private WiFi for ESP32 nodes |
| Display | IHANFO 7" IPS (HDMI, 1024x600) | 1 | Touchscreen kiosk UI |
| Power Bank | UGREEN 25,000mAh (140W USB-C PD) | 1 | Powers MeLE + display |
| Sensor Node | Heemol ESP32-S3 N16R8 DevKit | 4-5 | WiFi CSI collection |
| Node UPS | TECNOIOT 18650 UPS HAT | 4-5 | Battery backup per node |
| Batteries | 18650 Li-ion cells (3000mAh+) | 8-10 | 2 per node UPS |
| Radar | HLK-LD2410S (24GHz mmWave) | 4-5 | Secondary presence detection |
| BLE Beacons | ABN05 wristbands (nRF52810) | 5-10 | Patient/staff identification |

> **In a hurry?** See [QUICKSTART.md](QUICKSTART.md) for a condensed version. This README is the full reference.

## Quick Start (Demo Mode)

You can run HeartBeatz without any hardware. Demo mode generates realistic simulated data with three built-in scenarios (patient monitoring, fall detection, occupancy tracking).

```bash
# Clone the repository
git clone https://github.com/stevenpeirsman/HeartBeatz.git
cd HeartBeatz

# Start with Docker
docker compose up -d

# Open the UI
open http://localhost:8080
```

The system auto-detects that no ESP32 nodes are reachable and falls back to demo mode. You'll see a "DEMO MODE" banner in the UI with a scenario selector.

To force demo mode explicitly, set `DEMO_MODE=true` in `.env`.

## MeLE N100 Setup (Full Hardware)

Follow these steps in order when setting up the MeLE N100 for the first time.

### Step 1: Install Ubuntu

Install Ubuntu 22.04 LTS (Server or Desktop minimal) on the MeLE N100.

- Use a USB stick with the Ubuntu installer (Rufus or Balena Etcher to create it).
- During install: set hostname to `heartbeatz`, create user `heartbeatz`.
- Choose "Minimal installation" — the kiosk script installs everything else.

After install, connect via keyboard/monitor or SSH and update:

```bash
sudo apt update && sudo apt upgrade -y
```

### Step 2: Install Docker

```bash
# Install Docker
sudo apt install -y docker.io docker-compose
sudo systemctl enable docker
sudo usermod -aG docker heartbeatz

# Log out and back in for group change to take effect
exit
```

Verify Docker works:

```bash
docker run hello-world
```

### Step 3: Clone the Repo

```bash
cd /opt
sudo git clone https://github.com/stevenpeirsman/HeartBeatz.git
sudo chown -R heartbeatz:heartbeatz HeartBeatz
cd HeartBeatz
```

### Step 4: Configure the Network

Connect the MeLE to the GL.iNet router via Ethernet, then run:

```bash
sudo bash system/network-setup.sh
```

This assigns a static IP (`192.168.8.10`) on the router's network. Verify with:

```bash
ping 192.168.8.1    # Should reach the router
ip addr show        # Should show 192.168.8.10
```

### Step 5: Configure the GL.iNet Router

Log into the router admin panel at `http://192.168.8.1`:

1. Set the WiFi SSID to `HeartBeatz` and password to `heartbeatz2026`.
2. Set the WiFi channel to **6** (fixed — must match the ESP32 firmware).
3. Disable band steering and channel auto-selection.
4. Set the DHCP range to `192.168.8.100–192.168.8.199` (keeps `.10` reserved for MeLE).

### Step 6: Start the Services

```bash
cd /opt/HeartBeatz

# Build the Node.js container
docker compose build

# Pull the sensing server image
docker compose pull sensing-server

# Start everything
docker compose up -d

# Verify both containers are healthy
docker compose ps
docker compose logs -f   # Ctrl+C to stop watching
```

Open `http://192.168.8.10:8080` in a browser to verify the UI loads.

### Step 7: Install Kiosk Mode

Once the UI works in a browser, install the kiosk auto-boot service:

```bash
sudo bash system/install-kiosk.sh
```

This does the following:

- Installs X11, Chromium, and display utilities.
- Creates a systemd service (`heartbeatz-kiosk`) that starts on boot.
- Launches Chromium in fullscreen kiosk mode pointing at `http://localhost:3000/setup`.
- Disables desktop login managers (GDM, LightDM).
- Sets up auto-login for the `heartbeatz` user.

Reboot to test:

```bash
sudo reboot
```

The MeLE should boot directly into the HeartBeatz UI on the 7" display.

### Managing the Kiosk

```bash
# Check kiosk status
sudo systemctl status heartbeatz-kiosk

# View kiosk logs
sudo journalctl -u heartbeatz-kiosk -f

# Restart the kiosk (e.g., after a UI update)
sudo systemctl restart heartbeatz-kiosk

# Temporarily disable kiosk (for maintenance)
sudo systemctl stop heartbeatz-kiosk
```

## ESP32-S3 Firmware

Each sensor node runs custom firmware that collects WiFi CSI data and sends it to the sensing server over UDP.

### Prerequisites

Install [PlatformIO](https://platformio.org/install/cli):

```bash
pip install platformio
```

### Build and Flash

```bash
cd firmware

# Build the firmware
pio run

# Flash to a connected ESP32-S3 (USB-C)
pio run --target upload

# Open serial monitor to verify it connects
pio device monitor --baud 115200
```

### What to Expect on Boot

The ESP32 serial output should show:

1. WiFi connecting to SSID `HeartBeatz`...
2. Got IP `192.168.8.1xx`
3. Sending CSI frames to `192.168.8.10:5005` at 50 Hz
4. LED blinks: slow = connecting, solid = streaming, fast = error

### Firmware Configuration

Default values are compile-time flags in `firmware/include/heartbeatz_config.h` (set via `platformio.ini` build flags, **not** `.env`). The key settings:

| Setting | Default | Description |
|---|---|---|
| `HEARTBEATZ_WIFI_SSID` | `HeartBeatz` | Router WiFi SSID |
| `HEARTBEATZ_WIFI_PASS` | `heartbeatz2026` | Router WiFi password |
| `HEARTBEATZ_SERVER_IP` | `192.168.8.10` | MeLE IP (UDP target) |
| `HEARTBEATZ_UDP_PORT` | `5005` | Sensing server UDP port |
| `HEARTBEATZ_CSI_RATE_HZ` | `50` | CSI frame rate |
| `HEARTBEATZ_CHANNEL` | `6` | WiFi channel (must match router) |
| `HEARTBEATZ_RADAR_ENABLED` | `0` | Set to `1` if LD2410S is wired |
| `HEARTBEATZ_POWER_SAVE` | `0` | Set to `1` for battery mode (~10 Hz) |

These can also be overridden at runtime via NVS (Non-Volatile Storage) through the setup wizard.

### Wiring the LD2410S Radar (Optional)

If you attach an LD2410S radar module to a sensor node:

```
ESP32-S3          LD2410S
────────          ───────
GPIO 17 (TX)  →   RX
GPIO 18 (RX)  ←   TX
3.3V          →   VCC
GND           →   GND
```

Set `HEARTBEATZ_RADAR_ENABLED=1` in `platformio.ini` build flags before flashing.

## Configuration Reference

All configuration is in the `.env` file at the project root. Copy `.env` to `.env.local` for site-specific overrides.

### Network

| Variable | Default | Description |
|---|---|---|
| `HEARTBEATZ_IP` | `192.168.8.10` | MeLE static IP |
| `GATEWAY_IP` | `192.168.8.1` | Router IP |
| `SUBNET` | `192.168.8.0/24` | Network subnet |

### Sensing Server

| Variable | Default | Description |
|---|---|---|
| `CSI_SOURCE` | `auto` | `auto`, `esp32`, or `simulated` |
| `SENSING_HTTP_PORT` | `3000` | REST API port |
| `SENSING_WS_PORT` | `3001` | WebSocket port |
| `SENSING_UDP_PORT` | `5005` | ESP32 CSI UDP ingest port |
| `SENSING_TICK_MS` | `100` | Processing tick rate (ms) |

### Node Discovery

| Variable | Default | Description |
|---|---|---|
| `DISCOVERY_INTERVAL_MS` | `5000` | How often to scan for nodes |
| `NODE_TIMEOUT_MS` | `15000` | Mark node offline after this |
| `NODE_SUBNET` | `192.168.8.0/24` | Expected node subnet |

### BLE Beacons

| Variable | Default | Description |
|---|---|---|
| `BLE_ENABLED` | `false` | Enable BLE beacon scanning |
| `BLE_HCI_DEVICE` | `hci0` | Bluetooth adapter (`hci0` = built-in) |
| `BLE_UUID_FILTER` | *(empty)* | iBeacon UUID filter (empty = all) |
| `BLE_RSSI_THRESHOLD` | `-70` | In-room RSSI threshold (dBm) |

### LD2410S Radar

| Variable | Default | Description |
|---|---|---|
| `RADAR_ENABLED` | `false` | Enable radar reading |
| `RADAR_SERIAL_PORT` | *(auto)* | Serial port (auto-detected if empty) |
| `RADAR_BAUD_RATE` | `256000` | LD2410S baud rate |

### Demo Mode

| Variable | Default | Description |
|---|---|---|
| `DEMO_MODE` | `auto` | `true`, `false`, or `auto` (probe server) |
| `DEMO_SCENARIO` | `patient-monitoring` | Starting scenario |

Available scenarios: `patient-monitoring`, `fall-detection`, `occupancy-tracking`.

### Display & Logging

| Variable | Default | Description |
|---|---|---|
| `DISPLAY_WIDTH` | `1024` | Kiosk display width (px) |
| `DISPLAY_HEIGHT` | `600` | Kiosk display height (px) |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

## Development

### Running Locally (Without Docker)

```bash
cd server
npm install
npm run dev     # Starts with --watch for auto-reload
```

The UI is served from `ui/` at `http://localhost:8080`. Without a sensing server running, demo mode activates automatically.

### Running Tests

```bash
cd server
npm test
```

Tests cover: config loading, node discovery polling, radar frame parsing, WebSocket event routing, simulator scenarios, and API endpoint validation.

### Project Structure

```
HeartBeatz/
├── docker-compose.yml      # Runs sensing-server + heartbeatz containers
├── .env                    # All configuration with defaults
├── server/                 # Node.js orchestration layer
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── index.js        # Entry point — boots all subsystems
│       ├── config.js       # Environment + persistent state
│       ├── discovery.js    # Polls sensing server for ESP32 nodes
│       ├── ble-scanner.js  # iBeacon/Eddystone tracking (Linux)
│       ├── radar.js        # LD2410S mmWave UART reader
│       ├── simulator.js    # Demo mode data generator (3 scenarios)
│       ├── websocket.js    # WS hub — enriches + broadcasts to UI
│       └── routes/
│           └── api.js      # REST endpoints (health, nodes, beacons, etc.)
├── ui/                     # Kiosk touchscreen interface
│   ├── index.html          # Splash → Setup Wizard → Live Dashboard
│   ├── css/app.css
│   └── js/
│       ├── app.js          # State machine + WebSocket client
│       └── room-map.js     # Canvas room visualization (12 layers)
├── firmware/               # ESP32-S3 PlatformIO project
│   ├── platformio.ini
│   ├── partitions.csv
│   └── include/
│       └── heartbeatz_config.h
├── system/                 # Linux system setup scripts
│   ├── install-kiosk.sh    # Configures auto-boot Chromium kiosk
│   └── network-setup.sh    # Static IP on GL.iNet network
└── cadquery/               # 3D enclosure STEP files
```

## Boot Sequence

When the MeLE powers on, here's what happens:

1. **systemd** starts the `heartbeatz-kiosk` service.
2. **Docker Compose** starts `sensing-server` (Rust) and `heartbeatz` (Node.js).
3. The kiosk script waits up to 120 seconds for the sensing server health check.
4. **Chromium** launches in fullscreen kiosk mode at `http://localhost:3000/setup`.
5. The **Splash Screen** shows a progress bar while polling `/api/health`.
6. Once ready, the **Setup Wizard** starts node discovery (polling `/api/nodes`).
7. After nodes are found, the wizard runs a 10-second **room calibration**.
8. The **Live Dashboard** opens with real-time vital signs, room map, and beacon tracking.

If the sensing server is unreachable, the system falls into demo mode with simulated data.

## Troubleshooting

### No ESP32 Nodes Detected

- Verify the router WiFi SSID is exactly `HeartBeatz` (case-sensitive) and the channel is **6**.
- Check that the ESP32 got an IP: open the serial monitor (`pio device monitor`).
- Ensure the MeLE firewall allows UDP on port 5005: `sudo ufw status`.
- Check the sensing server logs: `docker compose logs sensing-server`.

### UI Shows "Connecting..." Indefinitely

- Verify both containers are running: `docker compose ps`.
- Check the heartbeatz container logs: `docker compose logs heartbeatz`.
- Test the API directly: `curl http://localhost:8080/api/health`.

### Demo Mode Activates When It Shouldn't

- The sensing server container may still be starting. Check its health: `docker compose ps`.
- Wait for the healthcheck to pass (up to 15 seconds after container start).
- Set `DEMO_MODE=false` in `.env` to force real mode (will show errors if server is down).

### Kiosk Display Issues

- If the display is blank, check `sudo systemctl status heartbeatz-kiosk`.
- The IHANFO display works over HDMI with no special drivers. Ensure the HDMI cable is connected before boot.
- For display resolution issues, verify `DISPLAY_WIDTH=1024` and `DISPLAY_HEIGHT=600` in `.env`.

### BLE Beacons Not Showing

- BLE is disabled by default. Set `BLE_ENABLED=true` in `.env`.
- BLE scanning requires host network mode. Uncomment `network_mode: host` in `docker-compose.yml`.
- Verify the Bluetooth adapter: `hcitool dev` (should show `hci0`).

### Radar Not Reading

- Radar is disabled by default. Set `RADAR_ENABLED=true` in `.env`.
- Uncomment the `devices` section in `docker-compose.yml` to pass through `/dev/ttyUSB0`.
- Check serial port: `ls /dev/ttyUSB*` or `ls /dev/ttyACM*`.

## License

Private project. Not for redistribution.
