/**
 * ===========================================================================
 * NVS Runtime Configuration — Implementation
 * ===========================================================================
 * Reads configuration from NVS (Non-Volatile Storage) and falls back to
 * compile-time defaults from heartbeatz_config.h for any missing keys.
 *
 * NVS is the ESP32's built-in key-value store in flash. It survives
 * reboots and OTA firmware updates, making it ideal for storing
 * user-configurable settings like WiFi credentials and server addresses.
 */

#include "nvs_config.h"
#include "heartbeatz_config.h"

#include <string.h>
#include "nvs.h"
#include "nvs_flash.h"
#include "esp_log.h"

static const char *TAG = "nvs_config";

/** NVS namespace for HeartBeatz configuration. */
#define NVS_NAMESPACE  "heartbeatz"

/* ---------------------------------------------------------------------------
 * Helper: Read a string from NVS or use default
 * --------------------------------------------------------------------------- */
static void load_string(nvs_handle_t nvs, const char *key,
                        char *dest, size_t dest_size, const char *default_val)
{
    size_t len = dest_size;
    esp_err_t err = nvs_get_str(nvs, key, dest, &len);
    if (err != ESP_OK) {
        strncpy(dest, default_val, dest_size - 1);
        dest[dest_size - 1] = '\0';
    }
}

/* ---------------------------------------------------------------------------
 * Helper: Read a uint8 from NVS or use default
 * --------------------------------------------------------------------------- */
static uint8_t load_u8(nvs_handle_t nvs, const char *key, uint8_t default_val)
{
    uint8_t val = default_val;
    nvs_get_u8(nvs, key, &val);
    return val;
}

/* ---------------------------------------------------------------------------
 * Helper: Read a uint16 from NVS or use default
 * --------------------------------------------------------------------------- */
static uint16_t load_u16(nvs_handle_t nvs, const char *key, uint16_t default_val)
{
    uint16_t val = default_val;
    nvs_get_u16(nvs, key, &val);
    return val;
}

/* ---------------------------------------------------------------------------
 * Helper: Read a uint32 from NVS or use default
 * --------------------------------------------------------------------------- */
static uint32_t load_u32(nvs_handle_t nvs, const char *key, uint32_t default_val)
{
    uint32_t val = default_val;
    nvs_get_u32(nvs, key, &val);
    return val;
}

/* ---------------------------------------------------------------------------
 * Public API
 * --------------------------------------------------------------------------- */

void nvs_config_load(heartbeatz_config_t *config)
{
    if (!config) return;

    /* Start with compile-time defaults */
    strncpy(config->wifi_ssid, HEARTBEATZ_WIFI_SSID, sizeof(config->wifi_ssid) - 1);
    strncpy(config->wifi_pass, HEARTBEATZ_WIFI_PASS, sizeof(config->wifi_pass) - 1);
    config->channel       = HEARTBEATZ_CHANNEL;
    strncpy(config->server_ip, HEARTBEATZ_SERVER_IP, sizeof(config->server_ip) - 1);
    config->udp_port      = HEARTBEATZ_UDP_PORT;
    config->csi_rate_hz   = HEARTBEATZ_CSI_RATE_HZ;
    config->radar_enabled = HEARTBEATZ_RADAR_ENABLED;
    config->radar_tx_pin  = HEARTBEATZ_RADAR_TX_PIN;
    config->radar_rx_pin  = HEARTBEATZ_RADAR_RX_PIN;
    config->radar_baud    = HEARTBEATZ_RADAR_BAUD;
    config->led_pin       = HEARTBEATZ_LED_PIN;
    config->power_save    = HEARTBEATZ_POWER_SAVE;

    /* Try to override with NVS values */
    nvs_handle_t nvs;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs);
    if (err != ESP_OK) {
        if (err == ESP_ERR_NVS_NOT_FOUND) {
            ESP_LOGI(TAG, "No NVS config found — using compile-time defaults");
        } else {
            ESP_LOGW(TAG, "NVS open failed (%s) — using defaults", esp_err_to_name(err));
        }
        return;
    }

    ESP_LOGI(TAG, "Loading config from NVS...");

    load_string(nvs, "wifi_ssid",  config->wifi_ssid, sizeof(config->wifi_ssid),  HEARTBEATZ_WIFI_SSID);
    load_string(nvs, "wifi_pass",  config->wifi_pass, sizeof(config->wifi_pass),  HEARTBEATZ_WIFI_PASS);
    config->channel       = load_u8(nvs, "channel",       HEARTBEATZ_CHANNEL);
    load_string(nvs, "server_ip",  config->server_ip, sizeof(config->server_ip),  HEARTBEATZ_SERVER_IP);
    config->udp_port      = load_u16(nvs, "udp_port",     HEARTBEATZ_UDP_PORT);
    config->csi_rate_hz   = load_u8(nvs, "csi_rate_hz",   HEARTBEATZ_CSI_RATE_HZ);
    config->radar_enabled = load_u8(nvs, "radar_enabled", HEARTBEATZ_RADAR_ENABLED) != 0;
    config->radar_tx_pin  = load_u8(nvs, "radar_tx_pin",  HEARTBEATZ_RADAR_TX_PIN);
    config->radar_rx_pin  = load_u8(nvs, "radar_rx_pin",  HEARTBEATZ_RADAR_RX_PIN);
    config->radar_baud    = load_u32(nvs, "radar_baud",   HEARTBEATZ_RADAR_BAUD);
    config->led_pin       = load_u8(nvs, "led_pin",       HEARTBEATZ_LED_PIN);
    config->power_save    = load_u8(nvs, "power_save",    HEARTBEATZ_POWER_SAVE) != 0;

    nvs_close(nvs);
    ESP_LOGI(TAG, "Config loaded from NVS");
}

bool nvs_config_save(const heartbeatz_config_t *config)
{
    if (!config) return false;

    nvs_handle_t nvs;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "NVS open for write failed: %s", esp_err_to_name(err));
        return false;
    }

    /* Write all fields — NVS internally handles no-change optimizations */
    nvs_set_str(nvs, "wifi_ssid",    config->wifi_ssid);
    nvs_set_str(nvs, "wifi_pass",    config->wifi_pass);
    nvs_set_u8(nvs,  "channel",      config->channel);
    nvs_set_str(nvs, "server_ip",    config->server_ip);
    nvs_set_u16(nvs, "udp_port",     config->udp_port);
    nvs_set_u8(nvs,  "csi_rate_hz",  config->csi_rate_hz);
    nvs_set_u8(nvs,  "radar_enabled", config->radar_enabled ? 1 : 0);
    nvs_set_u8(nvs,  "radar_tx_pin", config->radar_tx_pin);
    nvs_set_u8(nvs,  "radar_rx_pin", config->radar_rx_pin);
    nvs_set_u32(nvs, "radar_baud",   config->radar_baud);
    nvs_set_u8(nvs,  "led_pin",      config->led_pin);
    nvs_set_u8(nvs,  "power_save",   config->power_save ? 1 : 0);

    err = nvs_commit(nvs);
    nvs_close(nvs);

    if (err != ESP_OK) {
        ESP_LOGE(TAG, "NVS commit failed: %s", esp_err_to_name(err));
        return false;
    }

    ESP_LOGI(TAG, "Config saved to NVS");
    return true;
}

bool nvs_config_reset(void)
{
    nvs_handle_t nvs;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "NVS open for reset failed: %s", esp_err_to_name(err));
        return false;
    }

    err = nvs_erase_all(nvs);
    if (err == ESP_OK) {
        err = nvs_commit(nvs);
    }
    nvs_close(nvs);

    if (err != ESP_OK) {
        ESP_LOGE(TAG, "NVS reset failed: %s", esp_err_to_name(err));
        return false;
    }

    ESP_LOGI(TAG, "NVS config reset to compile-time defaults");
    return true;
}
