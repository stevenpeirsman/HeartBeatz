/**
 * ===========================================================================
 * LD2410S mmWave Radar Reader — Implementation
 * ===========================================================================
 * Reads and parses binary frames from the HLK-LD2410S 24GHz mmWave radar
 * module via UART. The parser handles:
 *   - Frame alignment (scanning for header magic bytes)
 *   - Split frames across UART reads (internal ring buffer)
 *   - Both basic (0x01) and engineering (0x02) mode frames
 *   - Garbage data rejection
 *
 * The LD2410S runs autonomously once powered — it continuously outputs
 * presence/motion frames without needing any configuration commands.
 * This simplifies integration: just read UART and parse.
 *
 * Frame format (matches server-side parser in radar.js):
 *   [F4 F3 F2 F1]  Header (4 bytes)
 *   [LL LH]         Data length (2 bytes LE)
 *   [TT]            Type: 0x01=basic, 0x02=engineering
 *   [SS]            State: 0=none, 1=moving, 2=stationary, 3=both
 *   [ML MH]         Moving target distance cm (2 bytes LE)
 *   [ME]            Moving target energy (0-100)
 *   [SL SH]         Stationary target distance cm (2 bytes LE)
 *   [SE]            Stationary target energy (0-100)
 *   [DL DH]         Detection distance cm (2 bytes LE, engineering mode)
 *   [F8 F7 F6 F5]  Tail (4 bytes)
 */

#include "radar_ld2410s.h"

#include <string.h>
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/task.h"

static const char *TAG = "ld2410s";

/* ---------------------------------------------------------------------------
 * Constants
 * --------------------------------------------------------------------------- */

/** Frame header magic bytes. */
static const uint8_t FRAME_HEADER[] = { 0xF4, 0xF3, 0xF2, 0xF1 };

/** Frame tail magic bytes. */
static const uint8_t FRAME_TAIL[]   = { 0xF8, 0xF7, 0xF6, 0xF5 };

/** UART receive buffer size. */
#define UART_BUF_SIZE       512

/** Maximum frame payload size we expect. */
#define MAX_PAYLOAD_SIZE    64

/** Minimum valid payload size (type + state + distances). */
#define MIN_PAYLOAD_SIZE    8

/* ---------------------------------------------------------------------------
 * Module State
 * --------------------------------------------------------------------------- */

static uart_port_t s_uart_num = UART_NUM_1;
static bool s_initialized = false;

/** Internal parse buffer for assembling frames across UART reads. */
static uint8_t s_parse_buf[UART_BUF_SIZE];
static size_t  s_parse_len = 0;

/* ---------------------------------------------------------------------------
 * Internal: Frame Parser
 * --------------------------------------------------------------------------- */

/**
 * Scan the parse buffer for a complete LD2410S frame.
 * If found, parse it into `reading` and return the number of bytes consumed.
 * If not found, return 0 (caller should read more UART data).
 */
static size_t parse_frame(radar_reading_t *reading)
{
    /* Need at least header(4) + length(2) + min_payload(8) + tail(4) = 18 bytes */
    if (s_parse_len < 18) return 0;

    /* Scan for header */
    size_t hdr_idx = 0;
    bool found = false;
    for (size_t i = 0; i <= s_parse_len - 4; i++) {
        if (memcmp(&s_parse_buf[i], FRAME_HEADER, 4) == 0) {
            hdr_idx = i;
            found = true;
            break;
        }
    }

    if (!found) {
        /* No header found — discard all but last 3 bytes (partial header) */
        if (s_parse_len > 3) {
            memmove(s_parse_buf, &s_parse_buf[s_parse_len - 3], 3);
            s_parse_len = 3;
        }
        return 0;
    }

    /* Discard bytes before header */
    if (hdr_idx > 0) {
        memmove(s_parse_buf, &s_parse_buf[hdr_idx], s_parse_len - hdr_idx);
        s_parse_len -= hdr_idx;
    }

    /* Need at least 6 bytes to read length field */
    if (s_parse_len < 6) return 0;

    /* Read payload length (little-endian, at offset 4) */
    uint16_t data_len = s_parse_buf[4] | (s_parse_buf[5] << 8);

    /* Sanity check */
    if (data_len > MAX_PAYLOAD_SIZE) {
        /* Invalid length — skip this header and try again */
        memmove(s_parse_buf, &s_parse_buf[4], s_parse_len - 4);
        s_parse_len -= 4;
        return 0;
    }

    /* Total frame size: header(4) + length(2) + payload(data_len) + tail(4) */
    size_t frame_len = 4 + 2 + data_len + 4;
    if (s_parse_len < frame_len) return 0;  /* Incomplete frame — need more data */

    /* Verify tail */
    if (memcmp(&s_parse_buf[frame_len - 4], FRAME_TAIL, 4) != 0) {
        /* Bad tail — skip header and scan again */
        memmove(s_parse_buf, &s_parse_buf[4], s_parse_len - 4);
        s_parse_len -= 4;
        return 0;
    }

    /* --- Parse payload --- */
    const uint8_t *payload = &s_parse_buf[6];

    if (data_len < MIN_PAYLOAD_SIZE) {
        /* Payload too short — skip */
        return frame_len;
    }

    uint8_t type = payload[0];
    if (type != 0x01 && type != 0x02) {
        /* Unknown type — skip */
        return frame_len;
    }

    uint8_t state_code = payload[1];
    if (state_code > 3) state_code = 0;

    reading->valid            = true;
    reading->state            = (radar_state_t)state_code;
    reading->moving_dist      = payload[2] | (payload[3] << 8);
    reading->moving_energy    = payload[4];
    reading->stationary_dist  = payload[5] | (payload[6] << 8);
    reading->stationary_energy = payload[7];

    /* Detection distance is only in engineering mode (type 0x02) with enough data */
    if (type == 0x02 && data_len >= 10) {
        reading->detection_dist = payload[8] | (payload[9] << 8);
    } else {
        reading->detection_dist = (state_code == 1 || state_code == 3)
                                ? reading->moving_dist
                                : reading->stationary_dist;
    }

    reading->timestamp_us = esp_timer_get_time();

    return frame_len;
}

/* ---------------------------------------------------------------------------
 * Public API
 * --------------------------------------------------------------------------- */

esp_err_t radar_ld2410s_init(const radar_config_t *config)
{
    if (!config) return ESP_ERR_INVALID_ARG;
    if (s_initialized) return ESP_ERR_INVALID_STATE;

    s_uart_num = config->uart_num;

    /* Configure UART parameters */
    uart_config_t uart_cfg = {
        .baud_rate  = config->baud_rate,
        .data_bits  = UART_DATA_8_BITS,
        .parity     = UART_PARITY_DISABLE,
        .stop_bits  = UART_STOP_BITS_1,
        .flow_ctrl  = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };

    esp_err_t err;

    err = uart_param_config(s_uart_num, &uart_cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "UART config failed: %s", esp_err_to_name(err));
        return err;
    }

    err = uart_set_pin(s_uart_num,
                       config->tx_pin, config->rx_pin,
                       UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "UART pin config failed: %s", esp_err_to_name(err));
        return err;
    }

    /* Install UART driver with RX buffer only (we don't send commands) */
    err = uart_driver_install(s_uart_num, UART_BUF_SIZE * 2, 0, 0, NULL, 0);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "UART driver install failed: %s", esp_err_to_name(err));
        return err;
    }

    s_parse_len = 0;
    s_initialized = true;

    ESP_LOGI(TAG, "LD2410S radar initialized on UART%d (TX=%d, RX=%d, baud=%d)",
             s_uart_num, config->tx_pin, config->rx_pin, config->baud_rate);
    return ESP_OK;
}

bool radar_ld2410s_read(radar_reading_t *reading, TickType_t timeout_ticks)
{
    if (!reading || !s_initialized) return false;

    memset(reading, 0, sizeof(*reading));

    TickType_t start_tick = xTaskGetTickCount();

    while (1) {
        /* Try to parse a frame from existing buffer data */
        size_t consumed = parse_frame(reading);
        if (consumed > 0) {
            /* Remove consumed bytes from parse buffer */
            if (consumed < s_parse_len) {
                memmove(s_parse_buf, &s_parse_buf[consumed], s_parse_len - consumed);
            }
            s_parse_len -= consumed;

            if (reading->valid) {
                return true;
            }
            /* Frame was invalid — continue scanning */
            continue;
        }

        /* Check timeout */
        TickType_t elapsed = xTaskGetTickCount() - start_tick;
        if (elapsed >= timeout_ticks) {
            return false;
        }

        /* Read more data from UART (with remaining timeout) */
        TickType_t remaining = timeout_ticks - elapsed;
        size_t space = sizeof(s_parse_buf) - s_parse_len;
        if (space == 0) {
            /* Buffer full but no valid frame found — reset */
            ESP_LOGW(TAG, "Parse buffer full with no valid frame — resetting");
            s_parse_len = 0;
            space = sizeof(s_parse_buf);
        }

        int bytes_read = uart_read_bytes(
            s_uart_num,
            &s_parse_buf[s_parse_len],
            space,
            remaining
        );

        if (bytes_read > 0) {
            s_parse_len += bytes_read;
        }
    }
}

void radar_ld2410s_deinit(void)
{
    if (!s_initialized) return;

    uart_driver_delete(s_uart_num);
    s_initialized = false;
    s_parse_len = 0;

    ESP_LOGI(TAG, "LD2410S radar de-initialized");
}
