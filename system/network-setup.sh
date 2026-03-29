#!/bin/bash
# ==============================================================================
# HeartBeatz Network Setup — Configure MeLE static IP on GL.iNet network
# ==============================================================================
#
# Sets up:
#   - Static IP 192.168.1.10 on Ethernet interface (to GL.iNet router)
#   - DNS pointing to router (192.168.1.1)
#   - Firewall rules for sensing server ports
#
# Run once on MeLE:
#   sudo bash network-setup.sh
#
# ==============================================================================

set -euo pipefail

echo "=== HeartBeatz Network Setup ==="

# Find the ethernet interface (usually enp* or eth0)
ETH_IFACE=$(ip -o link show | awk -F': ' '{print $2}' | grep -E '^(enp|eth)' | head -1)

if [ -z "$ETH_IFACE" ]; then
  echo "ERROR: No ethernet interface found"
  exit 1
fi

echo "Configuring interface: ${ETH_IFACE}"

# Create netplan config for static IP
cat > /etc/netplan/01-heartbeatz.yaml << NETPLAN
# HeartBeatz network config — static IP on GL.iNet MT3000 network
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

# Apply
netplan apply

echo "Static IP configured: 192.168.1.10"
echo ""

# Open firewall ports (if ufw is active)
if command -v ufw &> /dev/null && ufw status | grep -q "active"; then
  echo "Configuring firewall..."
  ufw allow 3000/tcp comment "HeartBeatz REST API"
  ufw allow 3001/tcp comment "HeartBeatz WebSocket"
  ufw allow 5005/udp comment "HeartBeatz CSI Ingest"
  ufw allow 8080/tcp comment "HeartBeatz Python UI"
  echo "Firewall rules added"
else
  echo "UFW not active, skipping firewall config"
fi

echo ""
echo "=== Network setup complete ==="
echo "  IP:     192.168.1.10"
echo "  Router: 192.168.1.1"
echo "  Ports:  3000 (REST), 3001 (WS), 5005/udp (CSI)"
echo ""
echo "  Test: ping 192.168.1.1"
