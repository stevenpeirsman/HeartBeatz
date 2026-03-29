/**
 * ===========================================================================
 * WiFi CSI Collection Module — Implementation
 * ===========================================================================
 * Connects to the HeartBeatz WiFi network and registers an ESP-IDF CSI
 * callback. Each CSI frame is pushed into a FreeRTOS queue for the
 * streaming task to consume.
 *
 * Key design decisions:
 *   - We use wifi_promiscuous mode + CSI callback (not just STA CSI)
 *     for maximum frame capture rate.
 *   - The CSI callback runs in WiFi task context — must be fast.
 *     We just memcpy the data into a queue item and return.
 *   - Queue depth is bounded; if the consumer can't keep up, we drop
 *     the oldest frame rather than blocking the WiFi stack.
 *   - WiFi reconnection is handled by the event handler automatically.
 */

#include "wifi_csi.h"

#include <string.h>
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/queue.h"

static const char *TAG = "wifi_csi";

/* ---------------------------------------------------------------------------
 * Module State
 * --------------------------------------------------------------------------- */

static QueueHandle_t s_csi_queue = NULL;
static EventGroupHandle_t s_events = NULL;
static EventBits_t s_connected_bit = 0;
static uint8_t s_node_mac[6] = {0};
static int s_retry_count = 0;

/** Maximum WiFi reconnection attempts before resetting. */
#define MAX_RETRY_COUNT  10

/* ---------------------------------------------------------------------------
 * WiFi Event Handler
 * ---------------------------------------------------------------------------
 * Handles STA_START, DISCONNECTED, and GOT_IP events for automatic
 * connection management. Sets/clears the connected bit in the shared
 * event group so other tasks know when the network is ready.
 */
static void wifi_event_handler(void *arg, esp_event_base_t event_base,
                               int32_t event_id, void *event_data)
{
    if (event_base == WIFI_EVENT) {
        switch (event_id) {
        case WIFI_EVENT_STA_START:
            ESP_LOGI(TAG, "WiFi station started — connecting...");
            esp_wifi_connect();
            break;

        case WIFI_EVENT_STA_DISCONNECTED:
            s_retry_count++;
            if (s_retry_count <= MAX_RETRY_COUNT) {
                ESP_LOGW(TAG, "WiFi disconnected — retry %d/%d",
                         s_retry_count, MAX_RETRY_COUNT);
                esp_wifi_connect();
            } else {
                ESP_LOGE(TAG, "WiFi reconnection failed after %d attempts", MAX_RETRY_COUNT);
                /* Clear connected bit — other tasks will notice */
                if (s_events) {
                    xEventGroupClearBits(s_events, s_connected_bit);
                }
            }
            break;

        case WIFI_EVENT_STA_CONNECTED:
            ESP_LOGI(TAG, "WiFi associated with AP");
            s_retry_count = 0;
            break;

        default:
            break;
        }
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;
        ESP_LOGI(TAG, "Got IP: " IPSTR, IP2STR(&event->ip_info.ip));
        s_retry_count = 0;

        /* Signal to waiting tasks that WiFi is ready */
        if (s_events) {
            xEventGroupSetBits(s_events, s_connected_bit);
        }
    }
}

/* ---------------------------------------------------------------------------
 * CSI Callback
 * ---------------------------------------------------------------------------
 * Called by the ESP-IDF WiFi stack for each received frame that contains
 * CSI data. This runs in the WiFi task context — MUST be fast.
 *
 * We copy the essential data into a queue item and return immediately.
 * If the queue is full, we overwrite the oldest item (non-blocking push).
 */
static void csi_callback(void *ctx, wifi_csi_info_t *info)
{
    if (!info || !info->buf || info->len == 0 || !s_csi_queue) {
        return;
    }

    wifi_csi_frame_t frame;
    memcpy(frame.mac, s_node_mac, 6);
    frame.rssi = info->rx_ctrl.rssi;
    frame.channel = info->rx_ctrl.channel;
    frame.timestamp_us = esp_timer_get_time();

    /* Copy CSI data (clamp to max buffer size) */
    frame.data_len = (info->len > WIFI_CSI_MAX_DATA_LEN)
                   ? WIFI_CSI_MAX_DATA_LEN
                   : info->len;
    memcpy(frame.data, info->buf, frame.data_len);

    /* Non-blocking push — if queue full, we drop this frame.
     * This is acceptable because CSI data is high-frequency and
     * missing one frame at 50 Hz is imperceptible. */
    if (xQueueSend(s_csi_queue, &frame, 0) != pdTRUE) {
        /* Queue full — consumer not keeping up. Silently drop. */
    }
}

/* ---------------------------------------------------------------------------
 * Public API
 * --------------------------------------------------------------------------- */

esp_err_t wifi_csi_init(const hb_csi_config_t *config)
{
    if (!config || !config->ssid) {
        return ESP_ERR_INVALID_ARG;
    }

    s_events = config->events;
    s_connected_bit = config->connected_bit;

    /* --- Create CSI frame queue --- */
    s_csi_queue = xQueueCreate(WIFI_CSI_QUEUE_DEPTH, sizeof(wifi_csi_frame_t));
    if (!s_csi_queue) {
        ESP_LOGE(TAG, "Failed to create CSI queue");
        return ESP_ERR_NO_MEM;
    }

    /* --- Initialize TCP/IP stack --- */
    ESP_ERROR_CHECK(esp_netif_init());
    esp_netif_create_default_wifi_sta();

    /* --- Initialize WiFi with default config --- */
    wifi_init_config_t wifi_init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&wifi_init));

    /* --- Register event handlers --- */
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, NULL, NULL));

    /* --- Configure WiFi station --- */
    wifi_config_t wifi_cfg = {
        .sta = {
            .threshold.authmode = WIFI_AUTH_WPA2_PSK,
            .sae_pwe_h2e = WPA3_SAE_PWE_BOTH,
        },
    };
    /* Copy SSID and password (must fit in 32/64 byte fields) */
    strncpy((char *)wifi_cfg.sta.ssid, config->ssid, sizeof(wifi_cfg.sta.ssid) - 1);
    strncpy((char *)wifi_cfg.sta.password, config->password, sizeof(wifi_cfg.sta.password) - 1);

    /* Lock to specific channel if configured (improves CSI consistency) */
    if (config->channel > 0 && config->channel <= 13) {
        wifi_cfg.sta.channel = config->channel;
    }

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_cfg));

    /* --- Get our MAC address (used in ADR-018 frame header) --- */
    ESP_ERROR_CHECK(esp_wifi_get_mac(WIFI_IF_STA, s_node_mac));
    ESP_LOGI(TAG, "Node MAC: %02x:%02x:%02x:%02x:%02x:%02x",
             s_node_mac[0], s_node_mac[1], s_node_mac[2],
             s_node_mac[3], s_node_mac[4], s_node_mac[5]);

    /* --- Configure and enable CSI collection --- */
    /*
     * Note: ESP-IDF uses `wifi_csi_config_t` for its own CSI settings.
     * Our module's config type is also named wifi_csi_config_t but lives
     * in wifi_csi.h. Here we need the ESP-IDF one, so we use the fully
     * qualified struct directly to avoid any ambiguity.
     */
    {
        wifi_csi_config_t esp_csi_cfg;
        memset(&esp_csi_cfg, 0, sizeof(esp_csi_cfg));

        /* Enable LLTF (Legacy Long Training Field) — best for sensing */
        esp_csi_cfg.lltf_en = true;
        esp_csi_cfg.htltf_en = true;
        esp_csi_cfg.stbc_htltf2_en = true;
        esp_csi_cfg.ltf_merge_en = true;
        esp_csi_cfg.channel_filter_en = false;  /* Keep all subcarriers */
        esp_csi_cfg.manu_scale = false;

        /* --- Start WiFi first (triggers STA_START event → auto-connect) --- */
        ESP_ERROR_CHECK(esp_wifi_start());

        /* CSI config must be set AFTER esp_wifi_start() */
        ESP_ERROR_CHECK(esp_wifi_set_csi_config(&esp_csi_cfg));
    }

    ESP_ERROR_CHECK(esp_wifi_set_csi_rx_cb(&csi_callback, NULL));
    ESP_ERROR_CHECK(esp_wifi_set_csi(true));

    ESP_LOGI(TAG, "WiFi CSI initialized — SSID: %s, channel: %d",
             config->ssid, config->channel);
    return ESP_OK;
}

bool wifi_csi_get_frame(wifi_csi_frame_t *frame, TickType_t timeout_ticks)
{
    if (!frame || !s_csi_queue) {
        return false;
    }
    return xQueueReceive(s_csi_queue, frame, timeout_ticks) == pdTRUE;
}

uint32_t wifi_csi_queue_count(void)
{
    if (!s_csi_queue) return 0;
    return (uint32_t)uxQueueMessagesWaiting(s_csi_queue);
}
