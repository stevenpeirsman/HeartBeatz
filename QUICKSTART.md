# HeartBeatz — Quick Start Guide

## What You Need

- **MeLE N100** mini PC (just arrived!)
- **USB stick** (8GB+) for Ubuntu installer
- **IHANFO 7" display** (HDMI)
- **GL.iNet MT3000** router (Ethernet cable to MeLE)
- A laptop/PC to create the USB stick
- A keyboard (just for initial setup — not needed after)

---

## Step 1: Create Ubuntu USB Stick (~5 min)

Download **Ubuntu Server 22.04.4 LTS** (not Desktop — we don't need a desktop environment):

> https://ubuntu.com/download/server

Flash it to USB with one of these:

| Your OS | Tool |
|---------|------|
| Windows | [Rufus](https://rufus.ie/) — select the ISO, pick your USB, click Start |
| Mac     | [balenaEtcher](https://etcher.balena.io/) — select ISO, select USB, Flash |
| Linux   | `sudo dd if=ubuntu-22.04.4-live-server-amd64.iso of=/dev/sdX bs=4M status=progress` |

---

## Step 2: Install Ubuntu on MeLE (~10 min)

1. Plug USB stick + keyboard + HDMI display into the MeLE
2. Power on, press **F7** (or **Del**) to enter boot menu
3. Select the USB stick
4. Follow the Ubuntu installer:
   - Language: English
   - Keyboard: your layout
   - Network: DHCP is fine for now (we'll set static IP later)
   - Storage: **Use entire disk** (the MeLE's internal eMMC)
   - Your name: `heartbeatz`
   - Server name: `heartbeatz`
   - Username: `heartbeatz`
   - Password: pick something simple for the demo box
   - **Install OpenSSH server: YES** (so you can SSH in later)
   - Featured snaps: skip all
5. Wait for install, remove USB when prompted, reboot

---

## Step 3: Copy HeartBeatz Files

After Ubuntu boots, log in and copy the project. Two options:

### Option A: From USB stick
```bash
# Plug in a USB stick with the HeartBeatz folder on it
sudo mount /dev/sdb1 /mnt
sudo bash /mnt/HeartBeatz/system/bootstrap.sh
```

### Option B: From your laptop over the network
```bash
# On your laptop (find MeLE's IP from router admin or use hostname):
scp -r HeartBeatz/ heartbeatz@heartbeatz.local:~/

# Then SSH into the MeLE:
ssh heartbeatz@heartbeatz.local
sudo bash ~/HeartBeatz/system/bootstrap.sh
```

---

## Step 4: Run Bootstrap (~10 min)

The bootstrap script does everything automatically:

```bash
sudo bash bootstrap.sh
```

It will:
1. Update Ubuntu
2. Install Docker, Node.js 20, Chromium
3. Configure static IP (192.168.8.10)
4. Install HeartBeatz server + UI
5. Set up kiosk auto-boot

**One manual step**: configure the GL.iNet router WiFi:
- Admin panel: http://192.168.8.1
- SSID: `HeartBeatz`
- Password: `heartbeatz2026`
- Channel: `6` (fixed, not auto)

---

## Step 5: Reboot & Go

```bash
sudo reboot
```

After reboot:
- Docker containers start automatically
- Chromium opens fullscreen on the 7" display
- The HeartBeatz splash screen appears
- Once the sensing server is ready, you'll see the setup wizard

---

## Troubleshooting

```bash
# SSH in from another device on the network
ssh heartbeatz@192.168.8.10

# Check kiosk service status
sudo systemctl status heartbeatz-kiosk

# Watch live logs
sudo journalctl -u heartbeatz-kiosk -f

# Check Docker containers
cd /opt/heartbeatz
docker compose ps
docker compose logs -f

# Restart everything
docker compose restart
sudo systemctl restart heartbeatz-kiosk

# Test the API manually
curl http://localhost:8080/api/health
```

---

## Network Map

```
  [GL.iNet MT3000 Router]
     WiFi: "HeartBeatz"
     LAN:  192.168.8.1
           │
           ├── 192.168.8.10  MeLE N100 (Ethernet)
           │     ├── :3000   Sensing Server REST
           │     ├── :3001   Sensing Server WebSocket
           │     ├── :5005   ESP32 CSI UDP ingest
           │     └── :8080   HeartBeatz UI (kiosk)
           │
           ├── 192.168.8.x   ESP32-S3 Node 1 (WiFi)
           ├── 192.168.8.x   ESP32-S3 Node 2 (WiFi)
           ├── 192.168.8.x   ESP32-S3 Node 3 (WiFi)
           └── 192.168.8.x   ESP32-S3 Node 4 (WiFi)
```
