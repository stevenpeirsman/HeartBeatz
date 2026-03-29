/**
 * ===========================================================================
 * WiFi CSI Collection Module — Header
 * ===========================================================================
 * Manages WiFi station connection and Channel State Information (CSI)
 * callback registration. CSI frames are pushed to an internal FreeRTOS
 * queue that the CSI streaming task drains.
 *
 * CSI (Channel State Information) captures the amplitude and phase of
 * each WiFi subcarrier, enabling contactless sensing of motion, presence,
 * breathing, and heart rate through signal analysis.
 *
 * Usage:
 *   hb_csi_config_t cfg = { .ssid = "HeartBeatz", ... };
 *   wifi_csi_init(&cfg);
 *   // In a task loop:
 *   wifi_csi_frame_t frame;
 *   if (wifi_csi_get_frame(&frame, timeout)) { ... }
 */

#ifndef WIFI_CSI_H
#define WIFI_CSI_H

#include <stdint.h>
#include <stdbool.h>
#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"

#ifdef __cplusplus
extern "C" {
#endif

/* ---------------------------------------------------------------------------
 * Constants
 * --------------------------------------------------------------------------- */

/** Maximum CSI data payload size (bytes). ESP32-S3 sends up to 384 bytes
 *  for HT40 mode (128 subcarriers × 2 bytes + LLTF/HT-LTF). */
#define WIFI_CSI_MAX_DATA_LEN  384

/** Maximum number of queued CSI frames before oldest are dropped. */
#define WIFI_CSI_QUEUE_DEPTH   16

/* ---------------------------------------------------------------------------
 * Types
 * --------------------------------------------------------------------------- */

/**
 * Configuration for the WiFi CSI module.
 */
typedef struct {
    const char *ssid;           /**< WiFi network SSID */
    const char *password;       /**< WiFi network password */
    uint8_t     channel;        /**< WiFi channel (1-13, 0 = auto) */
    uint8_t     rate_hz;        /**< Target CSI collection rate (10-100 Hz) */
    EventGroupHandle_t events;  /**< Event group for connection status */
    EventBits_t connected_bit;  /**< Bit to set when WiFi connects */
} hb_csi_config_t;

/**
 * A single CSI frame captured from the WiFi stack.
 * Contains raw subcarrier amplitude/phase data plus metadata.
 */
typedef struct {
    uint8_t  mac[6];           /**< Source MAC address of this node */
    int8_t   rssi;             /**< RSSI of the received frame (dBm) */
    uint8_t  channel;          /**< WiFi channel */
    uint16_t data_len;         /**< Length of CSI data payload (bytes) */
    uint8_t  data[WIFI_CSI_MAX_DATA_LEN];  /**< Raw CSI amplitude/phase */
    int64_t  timestamp_us;     /**< Capture timestamp (microseconds since boot) */
} wifi_csi_frame_t;

/* ---------------------------------------------------------------------------
 * Public API
 * --------------------------------------------------------------------------- */

/**
 * Initialize WiFi in station mode and register the CSI callback.
 * Starts the WiFi connection process (non-blocking).
 *
 * @param config  WiFi and CSI configuration
 * @return ESP_OK on success, error code on failure
 */
esp_err_t wifi_csi_init(const hb_csi_config_t *config);

/**
 * Get the next CSI frame from the internal queue.
 * Blocks for up to `timeout_ticks` waiting for a frame.
 *
 * @param[out] frame    Destination for the CSI frame data
 * @param timeout_ticks Maximum ticks to wait (use pdMS_TO_TICKS)
 * @return true if a frame was received, false on timeout
 */
bool wifi_csi_get_frame(wifi_csi_frame_t *frame, TickType_t timeout_ticks);

/**
 * Get the number of CSI frames currently queued.
 * Useful for monitoring backpressure.
 *
 * @return Number of frames waiting in the queue
 */
uint32_t wifi_csi_queue_count(void);

#ifdef __cplusplus
}
#endif

#endif /* WIFI_CSI_H */
