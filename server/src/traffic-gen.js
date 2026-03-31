// ==============================================================================
// WiFi Traffic Generator for CSI
// ==============================================================================
// ESP32 CSI callbacks only fire when WiFi frames are received. In a quiet
// network, only beacon frames (~10/sec) trigger CSI. To get higher frame
// rates for better person detection, we generate UDP traffic from the MeLE
// to the ESP32 nodes. Each ping-like packet triggers a CSI measurement.
//
// This runs alongside the CSI bridge and sends small UDP packets to each
// known ESP32 node at ~20 Hz, boosting the effective CSI sample rate.
//
// Usage: node traffic-gen.js
// Env:   TARGET_IPS=10.0.0.52,10.0.0.53  RATE_HZ=20

import dgram from 'dgram';

const TARGET_IPS = (process.env.TARGET_IPS || '10.0.0.52,10.0.0.53,10.0.0.54').split(',');
const RATE_HZ = parseInt(process.env.RATE_HZ || '20', 10);
const TARGET_PORT = 9999;  // Arbitrary port — ESP32 will ignore it but WiFi stack will see it

const socket = dgram.createSocket('udp4');
const payload = Buffer.from('HB_CSI_PING');

let seq = 0;

const interval = setInterval(() => {
  for (const ip of TARGET_IPS) {
    socket.send(payload, TARGET_PORT, ip.trim(), (err) => {
      if (err && seq % 1000 === 0) {
        console.error(`[TrafficGen] Send error to ${ip}: ${err.message}`);
      }
    });
  }
  seq++;
  if (seq % (RATE_HZ * 60) === 0) {
    console.log(`[TrafficGen] Sent ${seq} pings (${RATE_HZ} Hz to ${TARGET_IPS.length} nodes)`);
  }
}, Math.floor(1000 / RATE_HZ));

console.log(`[TrafficGen] Sending ${RATE_HZ} Hz UDP pings to: ${TARGET_IPS.join(', ')}`);

process.on('SIGINT', () => {
  clearInterval(interval);
  socket.close();
  process.exit(0);
});
