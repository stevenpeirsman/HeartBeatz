# HeartBeatz — Fully Remote Install (No Keyboard)

## Overview

This guide gets Ubuntu + HeartBeatz running on the MeLE N100 without ever
touching a keyboard. You only need your laptop and a USB stick.

**Total time: ~20 minutes hands-on, ~15 minutes waiting**

---

## What You Need

- MeLE N100 (just arrived)
- USB stick (8GB+)
- Ethernet cable (MeLE → GL.iNet router, or your home network for now)
- HDMI cable + IHANFO 7" display (optional — just to see what's happening)
- Your laptop (Windows) to prepare the USB stick

---

## The One Catch: BIOS Boot Order

There IS one moment where you might need a keyboard: telling the MeLE to
boot from USB instead of its internal Windows drive.

**Try this first (often works on MeLE):**

Many MeLE N100 models auto-detect a bootable USB and boot from it.
Just plug in the USB, power on, and wait 30 seconds. If you see the
Ubuntu installer starting, you're golden — skip to "Wait for Install".

**If it boots to Windows instead:**

You have 3 options (easiest first):

### Option A: Change boot order from Windows (fully remote)
1. Connect MeLE to your network via Ethernet
2. Let it boot to Windows
3. Find its IP in your router admin page (http://192.168.8.1 → DHCP leases)
4. Remote Desktop into it from your laptop:
   - Windows: `mstsc` → enter the IP
   - Mac: install "Microsoft Remote Desktop" from App Store
   - Note: Windows RDP might not be enabled by default. If this doesn't work, try Option B
5. Once in Windows, open CMD as admin and run:
   ```
   bcdedit /set {fwbootmgr} displayorder {bootmgr} /addfirst
   shutdown /r /fw /t 0
   ```
   This reboots into BIOS settings. From there you can change boot order.

### Option B: Use Windows to flash Ubuntu (fully remote)
If you can RDP into Windows but can't change BIOS:
1. Remote Desktop into the MeLE
2. Download Rufus + Ubuntu ISO inside Windows
3. Run Rufus, flash the USB **while Windows is running**
4. Open CMD as admin: `shutdown /r /o /t 0`
5. This opens "Advanced Startup" → "Use a device" → select USB

### Option C: Borrow a keyboard for 10 seconds
Plug in any USB keyboard, press **F7** at boot to get the boot menu,
select the USB stick, unplug the keyboard. Done. Everything after this
is remote.

---

## Step 1: Prepare the Autoinstall USB (~5 min)

On your laptop:

### 1a. Download Ubuntu Server 22.04.4 LTS
https://ubuntu.com/download/server

### 1b. Flash it with Rufus
1. Download [Rufus](https://rufus.ie/) (portable version is fine)
2. Insert USB stick
3. In Rufus:
   - Device: your USB stick
   - Boot selection: the Ubuntu ISO
   - Partition scheme: GPT
   - Click START
   - If asked about ISO mode: choose "Write in ISO Image mode"
4. Wait for it to finish

### 1c. Add the autoinstall config
After Rufus finishes, the USB stick should appear as a drive in Explorer.

1. Open the USB stick in Explorer
2. Create a folder called `autoinstall` in the root of the USB
3. Copy these two files from `HeartBeatz/system/autoinstall/` into that folder:
   - `user-data`
   - `meta-data`

Your USB should now have:
```
USB drive (E:)
├── autoinstall/
│   ├── user-data
│   └── meta-data
├── boot/
├── casper/
├── ... (other Ubuntu files)
```

### 1d. Make it truly unattended (skip the confirmation prompt)

Edit the file `boot/grub/grub.cfg` on the USB stick.

Find the line that says:
```
linux /casper/vmlinuz ---
```

Change it to:
```
linux /casper/vmlinuz autoinstall ds=nocloud;s=/cdrom/autoinstall/ ---
```

This tells Ubuntu: "Yes, really install automatically, and here's my config."

---

## Step 2: Boot the MeLE from USB

1. Plug the USB stick into the MeLE
2. Connect Ethernet cable
3. (Optional) Connect HDMI to 7" display so you can watch
4. Power on

If the BIOS is set to try USB first (or you changed it), Ubuntu starts
installing automatically. You'll see text scrolling on the display.

**The install takes about 10-15 minutes.** It will:
- Wipe the internal drive (bye Windows)
- Install Ubuntu Server 22.04
- Create user `heartbeatz` with password `heartbeatz`
- Enable SSH
- Reboot automatically when done

---

## Step 3: SSH In (~2 min after reboot)

After the MeLE reboots from its internal drive:

1. Wait 2-3 minutes for it to fully boot
2. Find its IP:
   - Check your router admin page (http://192.168.8.1), OR
   - Try: `ping heartbeatz.local` from your laptop, OR
   - Try common DHCP addresses: `ssh heartbeatz@192.168.8.x`
3. SSH in:
   ```
   ssh heartbeatz@<IP_ADDRESS>
   ```
   Password: `heartbeatz`

The first-boot service will have already installed Docker, Node.js, and
Chromium. Check with:
```bash
docker --version
node --version
```

If they're not installed yet, wait a few minutes — the first-boot script
runs after network is available. Check its progress:
```bash
sudo journalctl -u heartbeatz-firstboot -f
```

---

## Step 4: Copy HeartBeatz Files & Bootstrap

From your laptop, copy the project to the MeLE:
```bash
scp -r HeartBeatz/ heartbeatz@<IP_ADDRESS>:~/
```

Then SSH in and run bootstrap:
```bash
ssh heartbeatz@<IP_ADDRESS>
sudo bash ~/HeartBeatz/system/bootstrap.sh
```

---

## Step 5: Reboot

```bash
sudo reboot
```

The MeLE boots → Docker starts → kiosk launches → HeartBeatz splash on
the 7" display. All automatic, no keyboard ever needed again.

---

## After Setup: All Management is Remote

```bash
# SSH in anytime
ssh heartbeatz@192.168.8.10

# Watch logs
sudo journalctl -u heartbeatz-kiosk -f

# Restart services
cd /opt/heartbeatz && docker compose restart

# Update code: scp new files, restart
scp -r HeartBeatz/server/ heartbeatz@192.168.8.10:~/HeartBeatz/
ssh heartbeatz@192.168.8.10 "cd /opt/heartbeatz && docker compose restart heartbeatz"
```

---

## Credentials Summary

| What            | Value               |
|-----------------|---------------------|
| Ubuntu user     | `heartbeatz`        |
| Ubuntu password | `heartbeatz`        |
| SSH port        | 22 (default)        |
| Static IP       | 192.168.8.10        |
| Router admin    | http://192.168.8.1  |
| WiFi SSID       | HeartBeatz          |
| WiFi password   | heartbeatz2026      |

**Change the passwords before any client demo!**
