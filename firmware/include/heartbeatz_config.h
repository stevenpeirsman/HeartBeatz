/**
 * ===========================================================================
 * HeartBeatz Sensor Node — Compile-time Configuration
 * ===========================================================================
 * Default values for node behaviour. All can be overridden at runtime via
 * NVS (Non-Volatile Storage) using the sensing server's /api/v1/config
 * endpoint or the HeartBeatz setup wizard.
 *
 * NVS namespace: "heartbeatz"
 * See nvs_config.c in the RuView firmware for the full key reference.
 */

#ifndef HEARTBEATZ_CONFIG_H
#define HEARTBEATZ_CONFIG_H

/* ── WiFi ─────────────────────────────────────────────────────────────── */

/** SSID of the WiFi network for CSI sensing */
#ifndef HEARTBEATZ_WIFI_SSID
#define HEARTBEATZ_WIFI_SSID   "NETGEAR47"
#endif

/** WiFi password */
#ifndef HEARTBEATZ_WIFI_PASS
#define HEARTBEATZ_WIFI_PASS   "littletrain265"
#endif

/** WiFi channel — fixed channel improves CSI consistency (0 = auto) */
#ifndef HEARTBEATZ_CHANNEL
#define HEARTBEATZ_CHANNEL     3
#endif

/* ── Sensing Server ───────────────────────────────────────────────────── */

/** IP address of the MeLE N100 running the sensing server */
#ifndef HEARTBEATZ_SERVER_IP
#define HEARTBEATZ_SERVER_IP   "10.0.0.51"
#endif

/** UDP port for ADR-018 binary CSI frames */
#ifndef HEARTBEATZ_UDP_PORT
#define HEARTBEATZ_UDP_PORT    5005
#endif

/** Target CSI frame rate (Hz). 50 Hz is standard for vital sign detection. */
#ifndef HEARTBEATZ_CSI_RATE_HZ
#define HEARTBEATZ_CSI_RATE_HZ 50
#endif

/* ── LD2410S Radar (optional, connected via UART) ─────────────────────── */

/** Set to 1 to enable radar reading and include in UDP payload */
#ifndef HEARTBEATZ_RADAR_ENABLED
#define HEARTBEATZ_RADAR_ENABLED 0
#endif

/** UART TX pin connected to LD2410S RX */
#ifndef HEARTBEATZ_RADAR_TX_PIN
#define HEARTBEATZ_RADAR_TX_PIN  17
#endif

/** UART RX pin connected to LD2410S TX */
#ifndef HEARTBEATZ_RADAR_RX_PIN
#define HEARTBEATZ_RADAR_RX_PIN  18
#endif

/** LD2410S baud rate (fixed by module) */
#ifndef HEARTBEATZ_RADAR_BAUD
#define HEARTBEATZ_RADAR_BAUD    256000
#endif

/* ── LED ──────────────────────────────────────────────────────────────── */

/** Status LED GPIO pin (built-in on most ESP32-S3 DevKits) */
#ifndef HEARTBEATZ_LED_PIN
#define HEARTBEATZ_LED_PIN       48
#endif

/* ── ADR-018 Frame Format ─────────────────────────────────────────────── */

/** Magic bytes identifying a HeartBeatz CSI frame */
#define HEARTBEATZ_FRAME_MAGIC   0xC5110001

/** Frame header size (bytes): magic(4) + version(2) + node_id(6) + seq(4) + ts(4) */
#define HEARTBEATZ_HEADER_SIZE   20

/* ── Power Management ─────────────────────────────────────────────────── */

/**
 * Sleep between CSI callbacks to save battery.
 * Set to 0 for continuous operation (mains-powered demo).
 * Set to 1 for battery-optimised mode (reduces rate to ~10 Hz).
 */
#ifndef HEARTBEATZ_POWER_SAVE
#define HEARTBEATZ_POWER_SAVE    0
#endif

#endif /* HEARTBEATZ_CONFIG_H */
