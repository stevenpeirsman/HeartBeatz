/**
 * ===========================================================================
 * NVS Runtime Configuration — Header
 * ===========================================================================
 * Loads and saves HeartBeatz configuration from Non-Volatile Storage (NVS).
 * NVS survives reboots and firmware updates, allowing runtime configuration
 * changes (via the HeartBeatz server API) without re-flashing.
 *
 * Priority: NVS values override compile-time defaults from heartbeatz_config.h
 *
 * NVS Namespace: "heartbeatz"
 * Keys:
 *   wifi_ssid       — WiFi SSID (string, max 32 chars)
 *   wifi_pass       — WiFi password (string, max 64 chars)
 *   channel         — WiFi channel (uint8)
 *   server_ip       — Sensing server IP (string, max 16 chars)
 *   udp_port        — Sensing server UDP port (uint16)
 *   csi_rate_hz     — CSI collection rate (uint8)
 *   radar_enabled   — LD2410S radar enabled (uint8, 0/1)
 *   radar_tx_pin    — Radar UART TX pin (uint8)
 *   radar_rx_pin    — Radar UART RX pin (uint8)
 *   radar_baud      — Radar UART baud rate (uint32)
 *   led_pin         — Status LED GPIO pin (uint8)
 */

#ifndef NVS_CONFIG_H
#define NVS_CONFIG_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ---------------------------------------------------------------------------
 * Types
 * --------------------------------------------------------------------------- */

/**
 * Runtime configuration structure.
 * All fields have sensible defaults from heartbeatz_config.h.
 * NVS values override these defaults.
 */
typedef struct {
    /* WiFi */
    char     wifi_ssid[33];     /**< WiFi SSID (null-terminated) */
    char     wifi_pass[65];     /**< WiFi password (null-terminated) */
    uint8_t  channel;           /**< WiFi channel (0 = auto) */

    /* Sensing server */
    char     server_ip[16];     /**< Server IP (e.g. "192.168.8.10") */
    uint16_t udp_port;          /**< UDP port for CSI frames */
    uint8_t  csi_rate_hz;       /**< Target CSI collection rate (Hz) */

    /* LD2410S Radar */
    bool     radar_enabled;     /**< Whether to read radar data */
    uint8_t  radar_tx_pin;      /**< UART TX pin */
    uint8_t  radar_rx_pin;      /**< UART RX pin */
    uint32_t radar_baud;        /**< UART baud rate */

    /* LED */
    uint8_t  led_pin;           /**< Status LED GPIO pin */

    /* Power */
    bool     power_save;        /**< Battery-optimized mode */
} heartbeatz_config_t;

/* ---------------------------------------------------------------------------
 * Public API
 * --------------------------------------------------------------------------- */

/**
 * Load configuration from NVS, falling back to compile-time defaults.
 * Always produces a valid config — missing NVS keys use defaults.
 *
 * @param[out] config  Destination for the loaded configuration
 */
void nvs_config_load(heartbeatz_config_t *config);

/**
 * Save the current configuration to NVS.
 * Only writes fields that differ from compile-time defaults
 * (minimizes NVS wear).
 *
 * @param config  Configuration to save
 * @return true if saved successfully, false on NVS error
 */
bool nvs_config_save(const heartbeatz_config_t *config);

/**
 * Reset all NVS configuration to compile-time defaults.
 * Erases the "heartbeatz" NVS namespace.
 *
 * @return true if reset successfully
 */
bool nvs_config_reset(void);

#ifdef __cplusplus
}
#endif

#endif /* NVS_CONFIG_H */
