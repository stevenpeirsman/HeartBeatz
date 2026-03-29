/**
 * ===========================================================================
 * LD2410S mmWave Radar Reader — Header
 * ===========================================================================
 * Reads presence/motion data from the HLK-LD2410S 24GHz radar module
 * connected via UART. The LD2410S outputs binary frames at ~10Hz with
 * target state, distance, and energy readings.
 *
 * This module mirrors the Node.js server-side radar parser (radar.js)
 * but runs on the ESP32 — it reads the same binary frame format and
 * produces the same data structure.
 *
 * Wiring (ESP32-S3 ↔ LD2410S):
 *   ESP32 TX (GPIO17) → LD2410S RX
 *   ESP32 RX (GPIO18) → LD2410S TX
 *   ESP32 3V3          → LD2410S VCC
 *   ESP32 GND          → LD2410S GND
 *
 * Frame format (engineering mode):
 *   Header: F4 F3 F2 F1
 *   Length: 2 bytes (little-endian)
 *   Type:   0x01 (basic) or 0x02 (engineering)
 *   State:  0=none, 1=moving, 2=stationary, 3=both
 *   Data:   movingDist(2) + movingEnergy(1) + stationaryDist(2) + stationaryEnergy(1)
 *   Tail:   F8 F7 F6 F5
 */

#ifndef RADAR_LD2410S_H
#define RADAR_LD2410S_H

#include <stdint.h>
#include <stdbool.h>
#include "esp_err.h"
#include "driver/uart.h"
#include "freertos/FreeRTOS.h"

#ifdef __cplusplus
extern "C" {
#endif

/* ---------------------------------------------------------------------------
 * Types
 * --------------------------------------------------------------------------- */

/**
 * Configuration for the LD2410S radar module.
 */
typedef struct {
    uart_port_t uart_num;   /**< UART port number (e.g. UART_NUM_1) */
    int         tx_pin;     /**< ESP32 TX GPIO → LD2410S RX */
    int         rx_pin;     /**< ESP32 RX GPIO → LD2410S TX */
    int         baud_rate;  /**< Baud rate (typically 256000) */
} radar_config_t;

/**
 * Target state reported by the LD2410S.
 */
typedef enum {
    RADAR_STATE_NONE       = 0,  /**< No target detected */
    RADAR_STATE_MOVING     = 1,  /**< Moving target only */
    RADAR_STATE_STATIONARY = 2,  /**< Stationary target only */
    RADAR_STATE_BOTH       = 3,  /**< Both moving and stationary targets */
} radar_state_t;

/**
 * A single radar reading from the LD2410S.
 * This structure matches the server-side RadarReading type in radar.js.
 */
typedef struct {
    bool          valid;              /**< Whether this reading contains valid data */
    radar_state_t state;              /**< Target state (none/moving/stationary/both) */
    uint16_t      moving_dist;        /**< Moving target distance in cm */
    uint8_t       moving_energy;      /**< Moving target energy (0-100) */
    uint16_t      stationary_dist;    /**< Stationary target distance in cm */
    uint8_t       stationary_energy;  /**< Stationary target energy (0-100) */
    uint16_t      detection_dist;     /**< Overall detection distance in cm */
    int64_t       timestamp_us;       /**< Capture timestamp (microseconds since boot) */
} radar_reading_t;

/* ---------------------------------------------------------------------------
 * Public API
 * --------------------------------------------------------------------------- */

/**
 * Initialize the UART and start receiving data from the LD2410S.
 *
 * @param config  UART pin and baud rate configuration
 * @return ESP_OK on success, error code on failure
 */
esp_err_t radar_ld2410s_init(const radar_config_t *config);

/**
 * Read the next complete radar frame.
 * Blocks for up to `timeout_ticks` waiting for valid data.
 *
 * @param[out] reading     Destination for the parsed reading
 * @param      timeout_ticks  Maximum ticks to wait
 * @return true if a valid reading was received, false on timeout
 */
bool radar_ld2410s_read(radar_reading_t *reading, TickType_t timeout_ticks);

/**
 * De-initialize the radar module and release UART resources.
 */
void radar_ld2410s_deinit(void);

#ifdef __cplusplus
}
#endif

#endif /* RADAR_LD2410S_H */
