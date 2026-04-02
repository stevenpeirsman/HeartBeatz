/**
 * node_id.c — Node identification via WS2812 LED blink pattern.
 *
 * After WiFi connects, fetches the node's 1-based index from the HeartBeatz
 * server, then blinks the built-in WS2812 (NeoPixel) RGB LED N times every
 * 30 seconds so the operator can tell which physical board is which.
 *
 * Uses the ESP-IDF 5.x RMT TX driver with a custom WS2812 encoder —
 * no external led_strip component needed.
 */

#include "node_id.h"

#include <string.h>
#include "esp_log.h"
#include "esp_http_client.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/rmt_tx.h"
#include "led_strip_encoder.h"

static const char *TAG = "node_id";

/** Resolved node index (0 = not yet known). */
static int s_node_index = 0;

/** RMT TX channel and encoder for WS2812. */
static rmt_channel_handle_t s_rmt_ch = NULL;
static rmt_encoder_handle_t s_encoder = NULL;

/** GPIO for the WS2812 LED (ESP32-S3 DevKitC built-in). */
#define NODE_ID_LED_GPIO  48
#define RMT_RESOLUTION_HZ  (10 * 1000 * 1000)  /* 10 MHz */

/* -- WS2812 control -------------------------------------------------------- */

static void init_ws2812(void)
{
    rmt_tx_channel_config_t tx_cfg = {
        .gpio_num = NODE_ID_LED_GPIO,
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = RMT_RESOLUTION_HZ,
        .mem_block_symbols = 64,
        .trans_queue_depth = 4,
    };
    esp_err_t err = rmt_new_tx_channel(&tx_cfg, &s_rmt_ch);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "RMT TX channel init failed: %s", esp_err_to_name(err));
        return;
    }

    led_strip_encoder_config_t enc_cfg = {
        .resolution = RMT_RESOLUTION_HZ,
    };
    err = rmt_new_led_strip_encoder(&enc_cfg, &s_encoder);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "LED encoder init failed: %s", esp_err_to_name(err));
        return;
    }

    rmt_enable(s_rmt_ch);
    ESP_LOGI(TAG, "WS2812 LED ready on GPIO %d", NODE_ID_LED_GPIO);
}

/** Send 3 bytes (GRB) to the single WS2812 pixel. */
static void ws2812_set(uint8_t r, uint8_t g, uint8_t b)
{
    if (!s_rmt_ch || !s_encoder) return;
    uint8_t grb[3] = { g, r, b };
    rmt_transmit_config_t tx_config = { .loop_count = 0 };
    rmt_transmit(s_rmt_ch, s_encoder, grb, sizeof(grb), &tx_config);
    rmt_tx_wait_all_done(s_rmt_ch, 100);
}

static void led_on(void)   { ws2812_set(0, 60, 255); }   /* Bright blue-white */
static void led_off(void)  { ws2812_set(0, 0, 0); }

/* -- HTTP helper ----------------------------------------------------------- */

#define RESP_BUF_SIZE 128
static char s_resp_buf[RESP_BUF_SIZE];

/**
 * Fetch node index using open/read API (avoids chunked-encoding issues
 * with the event handler approach).
 */
static int fetch_node_index(const char *server_ip, const uint8_t mac[6])
{
    char url[128];
    snprintf(url, sizeof(url),
             "http://%s:3000/api/nodes/identify?mac=%02x:%02x:%02x:%02x:%02x:%02x",
             server_ip, mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);

    ESP_LOGI(TAG, "Fetching: %s", url);

    esp_http_client_config_t cfg = {
        .url = url,
        .timeout_ms = 5000,
    };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    if (!client) return 0;

    esp_err_t err = esp_http_client_open(client, 0);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "HTTP open failed: %s", esp_err_to_name(err));
        esp_http_client_cleanup(client);
        return 0;
    }

    int content_length = esp_http_client_fetch_headers(client);
    int status = esp_http_client_get_status_code(client);

    if (status != 200) {
        ESP_LOGW(TAG, "HTTP %d (content_length=%d)", status, content_length);
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return 0;
    }

    /* Read response body directly */
    int read_len = esp_http_client_read(client, s_resp_buf, RESP_BUF_SIZE - 1);
    esp_http_client_close(client);
    esp_http_client_cleanup(client);

    if (read_len <= 0) {
        ESP_LOGW(TAG, "Empty response (read_len=%d)", read_len);
        return 0;
    }
    s_resp_buf[read_len] = '\0';
    ESP_LOGI(TAG, "Response: %s", s_resp_buf);

    /* Parse {"index":N} */
    const char *p = strstr(s_resp_buf, "\"index\"");
    if (!p) return 0;
    p = strchr(p, ':');
    if (!p) return 0;
    int idx = atoi(p + 1);
    return (idx >= 1 && idx <= 99) ? idx : 0;
}

/* -- LED blink ------------------------------------------------------------- */

static void blink_id(int count)
{
    led_off();
    vTaskDelay(pdMS_TO_TICKS(500));

    for (int i = 0; i < count; i++) {
        led_on();
        vTaskDelay(pdMS_TO_TICKS(250));
        led_off();
        vTaskDelay(pdMS_TO_TICKS(250));
    }

    vTaskDelay(pdMS_TO_TICKS(800));
}

/* -- Public API ------------------------------------------------------------ */

int node_id_get(void) { return s_node_index; }

void node_id_task(void *arg)
{
    const char *server_ip = (const char *)arg;

    /* Init WS2812 via RMT */
    init_ws2812();

    /* Get WiFi STA MAC */
    uint8_t mac[6];
    esp_wifi_get_mac(WIFI_IF_STA, mac);
    ESP_LOGI(TAG, "MAC: %02x:%02x:%02x:%02x:%02x:%02x",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);

    /* Wait for server to register us */
    vTaskDelay(pdMS_TO_TICKS(5000));

    /* Fetch our index — retry up to 10 times */
    for (int attempt = 0; attempt < 10 && s_node_index == 0; attempt++) {
        s_node_index = fetch_node_index(server_ip, mac);
        if (s_node_index > 0) {
            ESP_LOGI(TAG, "Identified as #%d — blinking %d times (twice at boot)",
                     s_node_index, s_node_index);
        } else {
            ESP_LOGW(TAG, "Attempt %d/10 failed — retrying in 5s", attempt + 1);
            vTaskDelay(pdMS_TO_TICKS(5000));
        }
    }

    if (s_node_index == 0) {
        ESP_LOGE(TAG, "Could not get node index — LED ID disabled");
        vTaskDelete(NULL);
        return;
    }

    /* Blink node number twice during boot, 10 seconds apart */
    blink_id(s_node_index);
    vTaskDelay(pdMS_TO_TICKS(10000));
    blink_id(s_node_index);

    ESP_LOGI(TAG, "Boot identification complete — task exiting");
    vTaskDelete(NULL);
}
