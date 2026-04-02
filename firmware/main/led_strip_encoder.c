/**
 * led_strip_encoder.c — RMT encoder for WS2812 addressable LEDs.
 * Adapted from ESP-IDF example (Apache 2.0 license, Espressif Systems).
 */

#include "esp_check.h"
#include "led_strip_encoder.h"

static const char *TAG = "led_encoder";

typedef struct {
    rmt_encoder_t base;
    rmt_encoder_t *bytes_encoder;
    rmt_encoder_t *copy_encoder;
    int state;
    rmt_symbol_word_t reset_code;
} rmt_led_strip_encoder_t;

static size_t rmt_encode_led_strip(rmt_encoder_t *encoder, rmt_channel_handle_t channel,
                                    const void *primary_data, size_t data_size,
                                    rmt_encode_state_t *ret_state)
{
    rmt_led_strip_encoder_t *led_enc = __containerof(encoder, rmt_led_strip_encoder_t, base);
    rmt_encoder_handle_t bytes_enc = led_enc->bytes_encoder;
    rmt_encoder_handle_t copy_enc = led_enc->copy_encoder;
    rmt_encode_state_t session_state = RMT_ENCODING_RESET;
    rmt_encode_state_t state = RMT_ENCODING_RESET;
    size_t encoded_symbols = 0;

    switch (led_enc->state) {
    case 0: /* Send GRB pixel data */
        encoded_symbols += bytes_enc->encode(bytes_enc, channel, primary_data, data_size, &session_state);
        if (session_state & RMT_ENCODING_COMPLETE) {
            led_enc->state = 1;
        }
        if (session_state & RMT_ENCODING_MEM_FULL) {
            state |= RMT_ENCODING_MEM_FULL;
            goto out;
        }
    /* fall-through */
    case 1: /* Send reset code */
        encoded_symbols += copy_enc->encode(copy_enc, channel, &led_enc->reset_code,
                                             sizeof(led_enc->reset_code), &session_state);
        if (session_state & RMT_ENCODING_COMPLETE) {
            led_enc->state = RMT_ENCODING_RESET;
            state |= RMT_ENCODING_COMPLETE;
        }
        if (session_state & RMT_ENCODING_MEM_FULL) {
            state |= RMT_ENCODING_MEM_FULL;
            goto out;
        }
    }
out:
    *ret_state = state;
    return encoded_symbols;
}

static esp_err_t rmt_del_led_strip_encoder(rmt_encoder_t *encoder)
{
    rmt_led_strip_encoder_t *led_enc = __containerof(encoder, rmt_led_strip_encoder_t, base);
    rmt_del_encoder(led_enc->bytes_encoder);
    rmt_del_encoder(led_enc->copy_encoder);
    free(led_enc);
    return ESP_OK;
}

static esp_err_t rmt_led_strip_encoder_reset(rmt_encoder_t *encoder)
{
    rmt_led_strip_encoder_t *led_enc = __containerof(encoder, rmt_led_strip_encoder_t, base);
    rmt_encoder_reset(led_enc->bytes_encoder);
    rmt_encoder_reset(led_enc->copy_encoder);
    led_enc->state = RMT_ENCODING_RESET;
    return ESP_OK;
}

esp_err_t rmt_new_led_strip_encoder(const led_strip_encoder_config_t *config,
                                     rmt_encoder_handle_t *ret_encoder)
{
    esp_err_t ret = ESP_OK;
    rmt_led_strip_encoder_t *led_enc = NULL;
    ESP_GOTO_ON_FALSE(config && ret_encoder, ESP_ERR_INVALID_ARG, err, TAG, "invalid argument");
    led_enc = calloc(1, sizeof(rmt_led_strip_encoder_t));
    ESP_GOTO_ON_FALSE(led_enc, ESP_ERR_NO_MEM, err, TAG, "no mem for led strip encoder");

    led_enc->base.encode = rmt_encode_led_strip;
    led_enc->base.del = rmt_del_led_strip_encoder;
    led_enc->base.reset = rmt_led_strip_encoder_reset;

    /* WS2812 bit timing */
    rmt_bytes_encoder_config_t bytes_cfg = {
        .bit0 = {
            .level0 = 1,
            .duration0 = 0.3 * config->resolution / 1000000,  /* T0H = 0.3us */
            .level1 = 0,
            .duration1 = 0.9 * config->resolution / 1000000,  /* T0L = 0.9us */
        },
        .bit1 = {
            .level0 = 1,
            .duration0 = 0.9 * config->resolution / 1000000,  /* T1H = 0.9us */
            .level1 = 0,
            .duration1 = 0.3 * config->resolution / 1000000,  /* T1L = 0.3us */
        },
        .flags.msb_first = 1,  /* WS2812 bit order: G7..G0 R7..R0 B7..B0 */
    };
    ESP_GOTO_ON_ERROR(rmt_new_bytes_encoder(&bytes_cfg, &led_enc->bytes_encoder), err, TAG, "create bytes encoder failed");

    rmt_copy_encoder_config_t copy_cfg = {};
    ESP_GOTO_ON_ERROR(rmt_new_copy_encoder(&copy_cfg, &led_enc->copy_encoder), err, TAG, "create copy encoder failed");

    /* Reset code: 50us low */
    uint32_t reset_ticks = config->resolution / 1000000 * 50 / 2;
    led_enc->reset_code = (rmt_symbol_word_t) {
        .level0 = 0, .duration0 = reset_ticks,
        .level1 = 0, .duration1 = reset_ticks,
    };

    *ret_encoder = &led_enc->base;
    return ESP_OK;

err:
    if (led_enc) {
        if (led_enc->bytes_encoder) rmt_del_encoder(led_enc->bytes_encoder);
        if (led_enc->copy_encoder) rmt_del_encoder(led_enc->copy_encoder);
        free(led_enc);
    }
    return ret;
}
