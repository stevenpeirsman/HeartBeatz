/**
 * led_strip_encoder.h — RMT encoder for WS2812 addressable LEDs.
 * Adapted from ESP-IDF example (Apache 2.0 license).
 */
#pragma once

#include <stdint.h>
#include "driver/rmt_encoder.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    uint32_t resolution;  /**< Encoder resolution in Hz */
} led_strip_encoder_config_t;

/**
 * Create RMT encoder for WS2812 LED strip pixels.
 */
esp_err_t rmt_new_led_strip_encoder(const led_strip_encoder_config_t *config,
                                     rmt_encoder_handle_t *ret_encoder);

#ifdef __cplusplus
}
#endif
