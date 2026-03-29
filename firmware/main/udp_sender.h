/**
 * ===========================================================================
 * UDP Frame Sender — Header
 * ===========================================================================
 * Sends binary ADR-018 frames to the RuView sensing server over UDP.
 * Uses BSD sockets for low overhead. The socket is kept open for the
 * lifetime of the application (no per-frame connect/close overhead).
 *
 * Thread-safe: multiple tasks can call udp_sender_send() concurrently.
 * Internally protected by a mutex.
 */

#ifndef UDP_SENDER_H
#define UDP_SENDER_H

#include <stdint.h>
#include <stddef.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/* ---------------------------------------------------------------------------
 * Types
 * --------------------------------------------------------------------------- */

/** Opaque handle to the UDP sender instance. */
typedef struct udp_sender *udp_sender_handle_t;

/** Configuration for the UDP sender. */
typedef struct {
    const char *server_ip;   /**< Destination IP address (e.g. "192.168.8.10") */
    uint16_t    port;        /**< Destination UDP port (e.g. 5005) */
} udp_sender_config_t;

/** Statistics tracked by the UDP sender. */
typedef struct {
    uint32_t frames_sent;      /**< Total frames successfully sent */
    uint32_t frames_failed;    /**< Total frames that failed to send */
    uint32_t bytes_sent;       /**< Total bytes sent */
    uint32_t last_send_us;     /**< Duration of last send in microseconds */
} udp_sender_stats_t;

/* ---------------------------------------------------------------------------
 * Public API
 * --------------------------------------------------------------------------- */

/**
 * Initialize the UDP sender. Creates a socket and stores the destination.
 * The socket remains open until udp_sender_deinit() is called.
 *
 * @param[in]  config  Server IP and port
 * @param[out] handle  Receives the sender handle
 * @return ESP_OK on success, error code on failure
 */
esp_err_t udp_sender_init(const udp_sender_config_t *config, udp_sender_handle_t *handle);

/**
 * Send a binary frame via UDP.
 * Thread-safe — can be called from any task.
 *
 * @param handle  Sender handle from udp_sender_init()
 * @param data    Frame data to send
 * @param len     Length of data in bytes
 * @return ESP_OK on success, ESP_FAIL on send error
 */
esp_err_t udp_sender_send(udp_sender_handle_t handle, const uint8_t *data, size_t len);

/**
 * Get cumulative sender statistics.
 *
 * @param handle  Sender handle
 * @param[out] stats  Destination for statistics
 */
void udp_sender_get_stats(udp_sender_handle_t handle, udp_sender_stats_t *stats);

/**
 * Close the UDP socket and free resources.
 *
 * @param handle  Sender handle (set to NULL after call)
 */
void udp_sender_deinit(udp_sender_handle_t handle);

#ifdef __cplusplus
}
#endif

#endif /* UDP_SENDER_H */
