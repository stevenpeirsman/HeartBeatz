/**
 * ===========================================================================
 * UDP Frame Sender — Implementation
 * ===========================================================================
 * Lightweight UDP sender using BSD sockets. Sends ADR-018 binary CSI
 * frames to the RuView sensing server running on the MeLE N100.
 *
 * Design:
 *   - Single socket, kept open for the application lifetime
 *   - sendto() per frame (UDP is connectionless, no handshake overhead)
 *   - Mutex-protected for thread safety (CSI + radar tasks may both send)
 *   - Statistics tracked for monitoring via the HeartBeatz API
 */

#include "udp_sender.h"

#include <string.h>
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "lwip/sockets.h"
#include "lwip/netdb.h"

static const char *TAG = "udp_sender";

/* ---------------------------------------------------------------------------
 * Internal State
 * --------------------------------------------------------------------------- */

struct udp_sender {
    int                  sock;       /**< BSD socket file descriptor */
    struct sockaddr_in   dest_addr;  /**< Pre-resolved destination address */
    SemaphoreHandle_t    mutex;      /**< Protects socket access */
    udp_sender_stats_t   stats;      /**< Cumulative statistics */
};

/* ---------------------------------------------------------------------------
 * Public API
 * --------------------------------------------------------------------------- */

esp_err_t udp_sender_init(const udp_sender_config_t *config, udp_sender_handle_t *handle)
{
    if (!config || !config->server_ip || !handle) {
        return ESP_ERR_INVALID_ARG;
    }

    /* Allocate sender state */
    struct udp_sender *sender = calloc(1, sizeof(struct udp_sender));
    if (!sender) {
        ESP_LOGE(TAG, "Failed to allocate sender");
        return ESP_ERR_NO_MEM;
    }

    /* Create mutex for thread-safe sending */
    sender->mutex = xSemaphoreCreateMutex();
    if (!sender->mutex) {
        free(sender);
        return ESP_ERR_NO_MEM;
    }

    /* Pre-resolve destination address */
    sender->dest_addr.sin_family = AF_INET;
    sender->dest_addr.sin_port = htons(config->port);
    if (inet_pton(AF_INET, config->server_ip, &sender->dest_addr.sin_addr) != 1) {
        ESP_LOGE(TAG, "Invalid server IP: %s", config->server_ip);
        vSemaphoreDelete(sender->mutex);
        free(sender);
        return ESP_ERR_INVALID_ARG;
    }

    /* Create UDP socket */
    sender->sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (sender->sock < 0) {
        ESP_LOGE(TAG, "Socket creation failed: errno %d", errno);
        vSemaphoreDelete(sender->mutex);
        free(sender);
        return ESP_FAIL;
    }

    /* Set socket to non-blocking for sendto (we don't want to stall CSI task) */
    int flags = fcntl(sender->sock, F_GETFL, 0);
    fcntl(sender->sock, F_SETFL, flags | O_NONBLOCK);

    /* Set send buffer size (32KB is enough for CSI frames at 50Hz) */
    int sndbuf = 32768;
    setsockopt(sender->sock, SOL_SOCKET, SO_SNDBUF, &sndbuf, sizeof(sndbuf));

    memset(&sender->stats, 0, sizeof(sender->stats));

    *handle = sender;

    ESP_LOGI(TAG, "UDP sender initialized → %s:%d (socket fd=%d)",
             config->server_ip, config->port, sender->sock);
    return ESP_OK;
}

esp_err_t udp_sender_send(udp_sender_handle_t handle, const uint8_t *data, size_t len)
{
    if (!handle || !data || len == 0) {
        return ESP_ERR_INVALID_ARG;
    }

    struct udp_sender *sender = handle;

    /* Take mutex (short hold — just the sendto call) */
    if (xSemaphoreTake(sender->mutex, pdMS_TO_TICKS(5)) != pdTRUE) {
        sender->stats.frames_failed++;
        return ESP_ERR_TIMEOUT;
    }

    int64_t start = esp_timer_get_time();

    int sent = sendto(
        sender->sock,
        data, len,
        0,  /* flags */
        (struct sockaddr *)&sender->dest_addr,
        sizeof(sender->dest_addr)
    );

    int64_t elapsed = esp_timer_get_time() - start;

    if (sent < 0) {
        sender->stats.frames_failed++;
        xSemaphoreGive(sender->mutex);

        /* EAGAIN/EWOULDBLOCK is normal for non-blocking socket under load */
        if (errno != EAGAIN && errno != EWOULDBLOCK) {
            ESP_LOGD(TAG, "sendto failed: errno %d", errno);
        }
        return ESP_FAIL;
    }

    sender->stats.frames_sent++;
    sender->stats.bytes_sent += (uint32_t)sent;
    sender->stats.last_send_us = (uint32_t)elapsed;

    xSemaphoreGive(sender->mutex);
    return ESP_OK;
}

void udp_sender_get_stats(udp_sender_handle_t handle, udp_sender_stats_t *stats)
{
    if (!handle || !stats) return;
    struct udp_sender *sender = handle;

    if (xSemaphoreTake(sender->mutex, pdMS_TO_TICKS(10)) == pdTRUE) {
        *stats = sender->stats;
        xSemaphoreGive(sender->mutex);
    }
}

void udp_sender_deinit(udp_sender_handle_t handle)
{
    if (!handle) return;
    struct udp_sender *sender = handle;

    if (sender->sock >= 0) {
        close(sender->sock);
        sender->sock = -1;
    }

    if (sender->mutex) {
        vSemaphoreDelete(sender->mutex);
    }

    ESP_LOGI(TAG, "UDP sender closed (sent %lu frames, %lu bytes)",
             sender->stats.frames_sent, sender->stats.bytes_sent);

    free(sender);
}
