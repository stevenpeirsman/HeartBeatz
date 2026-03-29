/**
 * ===========================================================================
 * HeartBeatz Sensor Node — Main Firmware
 * ===========================================================================
 * ESP32-S3 firmware for the HeartBeatz portable demo box. Each sensor node:
 *
 *   1. Connects to the HeartBeatz WiFi network (GL.iNet router)
 *   2. Registers a CSI callback to capture WiFi channel state information
 *   3. Packages CSI frames in ADR-018 binary format
 *   4. Streams frames via UDP to the MeLE N100 sensing server
 *   5. (Optional) Reads LD2410S mmWave radar data and appends to frames
 *   6. Reports status via built-in LED (breathing pattern = healthy)
 *   7. Supports OTA firmware updates from the HeartBeatz server
 *
 * Architecture:
 *   ┌─────────────────────────────────────────┐
 *   │  FreeRTOS Tasks                         │
 *   │  ├── main_task     — Init + orchestrate │
 *   │  ├── csi_task      — CSI callback + UDP │
 *   │  ├── radar_task    — LD2410S UART read  │
 *   │  ├── led_task      — Status LED control │
 *   │  └── ota_task      — OTA update check   │
 *   └─────────────────────────────────────────┘
 *
 * Build:   pio run
 * Flash:   pio run --target upload
 * Monitor: pio device monitor --baud 115200
 *
 * Configuration: see include/heartbeatz_config.h
 * Runtime overrides: stored in NVS namespace "heartbeatz"
 */

#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"
#include "freertos/semphr.h"
#include "esp_system.h"
#include "esp_mac.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "esp_event.h"
#include "esp_app_format.h"
#include "esp_ota_ops.h"
#include "esp_http_client.h"
#include "nvs_flash.h"

#include "heartbeatz_config.h"
#include "nvs_config.h"
#include "wifi_csi.h"
#include "udp_sender.h"
#include "led_status.h"
#include "radar_ld2410s.h"

/* ---------------------------------------------------------------------------
 * Constants
 * --------------------------------------------------------------------------- */

static const char *TAG = "heartbeatz";

/** FreeRTOS event group bits for system state tracking. */
#define WIFI_CONNECTED_BIT   BIT0
#define CSI_STREAMING_BIT    BIT1
#define RADAR_READY_BIT      BIT2
#define OTA_IN_PROGRESS_BIT  BIT3

/** Task stack sizes (bytes). Tuned for ESP32-S3 with PSRAM. */
#define CSI_TASK_STACK     8192
#define RADAR_TASK_STACK   4096
#define LED_TASK_STACK     2048
#define OTA_TASK_STACK     8192

/** Task priorities (higher number = higher priority). */
#define CSI_TASK_PRIO      10   /* Highest — real-time CSI streaming */
#define RADAR_TASK_PRIO     8   /* High — UART must not overflow */
#define LED_TASK_PRIO       2   /* Low — cosmetic only */
#define OTA_TASK_PRIO       3   /* Low — runs periodically */

/* ---------------------------------------------------------------------------
 * Globals
 * --------------------------------------------------------------------------- */

/** Shared event group for cross-task signalling. */
static EventGroupHandle_t s_system_events = NULL;

/** Runtime configuration loaded from NVS (or compile-time defaults). */
static heartbeatz_config_t s_config;

/** UDP sender handle (shared between CSI callback and radar task). */
static udp_sender_handle_t s_udp = NULL;

/** Latest radar reading (written by radar task, read by CSI callback). */
static radar_reading_t s_radar_reading = {0};
static SemaphoreHandle_t s_radar_mutex = NULL;

/* ---------------------------------------------------------------------------
 * Forward Declarations
 * --------------------------------------------------------------------------- */

static void csi_task(void *arg);
static void radar_task(void *arg);
static void led_task(void *arg);
static void ota_check_task(void *arg);

/* ---------------------------------------------------------------------------
 * Main Entry Point
 * --------------------------------------------------------------------------- */

void app_main(void)
{
    ESP_LOGI(TAG, "╔══════════════════════════════════════════╗");
    ESP_LOGI(TAG, "║  HeartBeatz Sensor Node v1.0.0           ║");
    ESP_LOGI(TAG, "║  WiFi CSI + Radar + OTA                  ║");
    ESP_LOGI(TAG, "╚══════════════════════════════════════════╝");

    /* --- Initialize NVS (required for WiFi + config storage) --- */
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES ||
        ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        /* NVS partition was truncated or format changed — erase and retry */
        ESP_LOGW(TAG, "NVS init failed (%s) — erasing and retrying", esp_err_to_name(ret));
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    } else {
        ESP_ERROR_CHECK(ret);
    }

    /* --- Load runtime configuration from NVS (falls back to compile-time defaults) --- */
    nvs_config_load(&s_config);
    ESP_LOGI(TAG, "Config: SSID=%s, server=%s:%d, CSI rate=%d Hz, radar=%s",
             s_config.wifi_ssid,
             s_config.server_ip,
             s_config.udp_port,
             s_config.csi_rate_hz,
             s_config.radar_enabled ? "ON" : "OFF");

    /* --- Create system event group --- */
    s_system_events = xEventGroupCreate();
    configASSERT(s_system_events);

    /* --- Create radar data mutex --- */
    s_radar_mutex = xSemaphoreCreateMutex();
    configASSERT(s_radar_mutex);

    /* --- Initialize default event loop (required for WiFi events) --- */
    ESP_ERROR_CHECK(esp_event_loop_create_default());

    /* --- Initialize LED status (starts breathing pattern immediately) --- */
    led_status_init(s_config.led_pin);
    led_status_set(LED_STATE_CONNECTING);

    /* --- Connect to WiFi and start CSI collection --- */
    ESP_LOGI(TAG, "Connecting to WiFi: %s (channel %d)", s_config.wifi_ssid, s_config.channel);
    hb_csi_config_t csi_cfg = {
        .ssid       = s_config.wifi_ssid,
        .password   = s_config.wifi_pass,
        .channel    = s_config.channel,
        .rate_hz    = s_config.csi_rate_hz,
        .events     = s_system_events,
        .connected_bit = WIFI_CONNECTED_BIT,
    };
    ESP_ERROR_CHECK(wifi_csi_init(&csi_cfg));

    /* --- Wait for WiFi connection (with timeout) --- */
    ESP_LOGI(TAG, "Waiting for WiFi connection...");
    EventBits_t bits = xEventGroupWaitBits(
        s_system_events, WIFI_CONNECTED_BIT,
        pdFALSE, pdTRUE,
        pdMS_TO_TICKS(30000)  /* 30 second timeout */
    );

    if (!(bits & WIFI_CONNECTED_BIT)) {
        ESP_LOGE(TAG, "WiFi connection timeout — restarting");
        led_status_set(LED_STATE_ERROR);
        vTaskDelay(pdMS_TO_TICKS(3000));
        esp_restart();
    }

    ESP_LOGI(TAG, "WiFi connected!");
    led_status_set(LED_STATE_IDLE);

    /* --- Initialize UDP sender --- */
    udp_sender_config_t udp_cfg = {
        .server_ip = s_config.server_ip,
        .port      = s_config.udp_port,
    };
    ESP_ERROR_CHECK(udp_sender_init(&udp_cfg, &s_udp));
    ESP_LOGI(TAG, "UDP sender ready → %s:%ld", s_config.server_ip, (long)s_config.udp_port);

    /* --- Launch FreeRTOS tasks --- */

    /* CSI streaming task (highest priority — real-time data) */
    xTaskCreatePinnedToCore(
        csi_task, "csi_task",
        CSI_TASK_STACK, NULL,
        CSI_TASK_PRIO, NULL,
        1  /* Pin to core 1 — keep core 0 for WiFi stack */
    );

    /* LD2410S radar task (if enabled) */
    if (s_config.radar_enabled) {
        xTaskCreatePinnedToCore(
            radar_task, "radar_task",
            RADAR_TASK_STACK, NULL,
            RADAR_TASK_PRIO, NULL,
            0  /* Core 0 — UART I/O */
        );
    }

    /* LED status task */
    xTaskCreate(led_task, "led_task", LED_TASK_STACK, NULL, LED_TASK_PRIO, NULL);

    /* OTA update check task */
    xTaskCreate(ota_check_task, "ota_task", OTA_TASK_STACK, NULL, OTA_TASK_PRIO, NULL);

    ESP_LOGI(TAG, "All tasks launched — node operational");
    led_status_set(LED_STATE_STREAMING);
}

/* ---------------------------------------------------------------------------
 * CSI Streaming Task
 * ---------------------------------------------------------------------------
 * Waits for CSI frames from the WiFi callback, packages them in ADR-018
 * format (with optional radar data appended), and sends via UDP.
 *
 * The CSI callback (in wifi_csi.c) pushes raw frames into a FreeRTOS queue.
 * This task drains the queue, assembles the binary payload, and sends it.
 */
static void csi_task(void *arg)
{
    ESP_LOGI(TAG, "[CSI] Task started — streaming at ~%d Hz", s_config.csi_rate_hz);
    uint32_t frame_seq = 0;
    uint32_t error_count = 0;

    while (1) {
        /* Wait for a CSI frame from the callback queue (blocks up to 100ms) */
        wifi_csi_frame_t csi_frame;
        if (!wifi_csi_get_frame(&csi_frame, pdMS_TO_TICKS(100))) {
            /* No frame available — WiFi might be scanning or reconnecting */
            continue;
        }

        /* --- Build ADR-018 binary frame --- */
        /*
         * ADR-018 frame layout:
         *   [0..3]   Magic: 0xC5110001 (big-endian)
         *   [4..5]   Version: 0x0001
         *   [6..11]  Node MAC address (6 bytes)
         *   [12..15] Sequence number (little-endian)
         *   [16..19] Timestamp ms (little-endian)
         *   [20..21] CSI data length (little-endian)
         *   [22..N]  CSI amplitude/phase data
         *   [N+1]    Radar present flag (0 or 1)
         *   [N+2..]  Radar data (if flag = 1): state(1) + dist(2) + energy(1)
         */
        uint8_t frame_buf[1500];  /* Max UDP payload */
        size_t offset = 0;

        /* Magic */
        frame_buf[offset++] = 0xC5;
        frame_buf[offset++] = 0x11;
        frame_buf[offset++] = 0x00;
        frame_buf[offset++] = 0x01;

        /* Version */
        frame_buf[offset++] = 0x00;
        frame_buf[offset++] = 0x01;

        /* Node MAC */
        memcpy(&frame_buf[offset], csi_frame.mac, 6);
        offset += 6;

        /* Sequence number (LE32) */
        frame_buf[offset++] = (frame_seq >>  0) & 0xFF;
        frame_buf[offset++] = (frame_seq >>  8) & 0xFF;
        frame_buf[offset++] = (frame_seq >> 16) & 0xFF;
        frame_buf[offset++] = (frame_seq >> 24) & 0xFF;

        /* Timestamp (LE32) — milliseconds since boot */
        uint32_t ts = (uint32_t)(esp_timer_get_time() / 1000);
        frame_buf[offset++] = (ts >>  0) & 0xFF;
        frame_buf[offset++] = (ts >>  8) & 0xFF;
        frame_buf[offset++] = (ts >> 16) & 0xFF;
        frame_buf[offset++] = (ts >> 24) & 0xFF;

        /* CSI data length (LE16) */
        uint16_t csi_len = csi_frame.data_len;
        frame_buf[offset++] = (csi_len >> 0) & 0xFF;
        frame_buf[offset++] = (csi_len >> 8) & 0xFF;

        /* CSI data payload */
        if (offset + csi_len + 10 < sizeof(frame_buf)) {
            memcpy(&frame_buf[offset], csi_frame.data, csi_len);
            offset += csi_len;
        }

        /* --- Append radar data (if available) --- */
        if (s_config.radar_enabled && xSemaphoreTake(s_radar_mutex, 0) == pdTRUE) {
            if (s_radar_reading.valid) {
                frame_buf[offset++] = 1;  /* Radar present flag */
                frame_buf[offset++] = s_radar_reading.state;
                frame_buf[offset++] = (s_radar_reading.moving_dist >> 0) & 0xFF;
                frame_buf[offset++] = (s_radar_reading.moving_dist >> 8) & 0xFF;
                frame_buf[offset++] = s_radar_reading.moving_energy;
                frame_buf[offset++] = (s_radar_reading.stationary_dist >> 0) & 0xFF;
                frame_buf[offset++] = (s_radar_reading.stationary_dist >> 8) & 0xFF;
                frame_buf[offset++] = s_radar_reading.stationary_energy;
            } else {
                frame_buf[offset++] = 0;  /* No radar data */
            }
            xSemaphoreGive(s_radar_mutex);
        } else {
            frame_buf[offset++] = 0;  /* No radar data */
        }

        /* --- Send via UDP --- */
        esp_err_t err = udp_sender_send(s_udp, frame_buf, offset);
        if (err == ESP_OK) {
            frame_seq++;
            if (frame_seq % 500 == 0) {
                ESP_LOGI(TAG, "[CSI] Sent %lu frames (last %u bytes)", frame_seq, (unsigned)offset);
            }
        } else {
            error_count++;
            if (error_count % 100 == 1) {
                ESP_LOGW(TAG, "[CSI] Send error (%s), total errors: %lu",
                         esp_err_to_name(err), error_count);
            }
        }
    }
}

/* ---------------------------------------------------------------------------
 * LD2410S Radar Task
 * ---------------------------------------------------------------------------
 * Continuously reads UART data from the LD2410S 24GHz mmWave radar module.
 * Parses binary frames and updates the shared radar reading structure.
 * The CSI task reads this data and appends it to outgoing UDP frames.
 */
static void radar_task(void *arg)
{
    ESP_LOGI(TAG, "[Radar] Task started — UART pins TX=%ld RX=%ld @ %ld baud",
             (long)s_config.radar_tx_pin, (long)s_config.radar_rx_pin, (long)s_config.radar_baud);

    /* Initialize the LD2410S radar reader */
    radar_config_t radar_cfg = {
        .uart_num   = UART_NUM_1,
        .tx_pin     = s_config.radar_tx_pin,
        .rx_pin     = s_config.radar_rx_pin,
        .baud_rate  = s_config.radar_baud,
    };

    esp_err_t err = radar_ld2410s_init(&radar_cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "[Radar] Init failed: %s", esp_err_to_name(err));
        vTaskDelete(NULL);
        return;
    }

    xEventGroupSetBits(s_system_events, RADAR_READY_BIT);
    ESP_LOGI(TAG, "[Radar] LD2410S initialized — reading frames");

    while (1) {
        radar_reading_t reading;
        if (radar_ld2410s_read(&reading, pdMS_TO_TICKS(200))) {
            /* Update the shared reading (protected by mutex) */
            if (xSemaphoreTake(s_radar_mutex, pdMS_TO_TICKS(10)) == pdTRUE) {
                s_radar_reading = reading;
                s_radar_reading.valid = true;
                xSemaphoreGive(s_radar_mutex);
            }
        }
    }
}

/* ---------------------------------------------------------------------------
 * LED Status Task
 * ---------------------------------------------------------------------------
 * Manages the on-board LED to indicate system state:
 *   - Fast blink:  Connecting to WiFi
 *   - Slow breathe: Connected, idle
 *   - Steady pulse: Streaming CSI data
 *   - Rapid flash:  Error state
 *   - Off:          OTA update in progress
 */
static void led_task(void *arg)
{
    ESP_LOGI(TAG, "[LED] Task started on GPIO %ld", (long)s_config.led_pin);

    while (1) {
        led_status_tick();
        vTaskDelay(pdMS_TO_TICKS(20));  /* ~50 Hz LED update rate */
    }
}

/* ---------------------------------------------------------------------------
 * OTA Update Check Task
 * ---------------------------------------------------------------------------
 * Periodically checks the HeartBeatz server for available firmware updates.
 * If an update is found, downloads it chunk-by-chunk, flashes it to the
 * inactive OTA partition, validates the image, and reboots.
 *
 * OTA endpoint: http://<server_ip>:8080/api/firmware/latest
 * The server returns:
 *   - 200 + binary:  new firmware available → download and flash
 *   - 304:           current firmware is up-to-date → no action
 *   - 404/5xx:       server not ready → retry later
 *
 * The node sends its current version in the X-Firmware-Version header so
 * the server can decide whether to serve an update.
 *
 * Partition layout (see partitions.csv):
 *   ota_0 (1.75MB) — app image slot A
 *   ota_1 (1.75MB) — app image slot B
 * ESP-IDF automatically selects the inactive slot for writing.
 */

/** Current firmware version — must match what the build system produces. */
#define HEARTBEATZ_FW_VERSION "1.0.0"

/** OTA HTTP read buffer size — 4KB is a good trade-off for ESP32 memory. */
#define OTA_BUF_SIZE 4096

static void ota_check_task(void *arg)
{
    const int CHECK_INTERVAL_SEC = 300;  /* Check every 5 minutes */
    const int RETRY_INTERVAL_SEC = 30;   /* Retry faster after a failure */
    const int OTA_SERVER_PORT = 8080;

    ESP_LOGI(TAG, "[OTA] Task started — v%s, checking %s:%d every %ds",
             HEARTBEATZ_FW_VERSION, s_config.server_ip, OTA_SERVER_PORT,
             CHECK_INTERVAL_SEC);

    /* Wait for WiFi to stabilize and CSI streaming to begin */
    vTaskDelay(pdMS_TO_TICKS(30000));

    while (1) {
        ESP_LOGI(TAG, "[OTA] Checking for firmware update...");

        /* Build the OTA check URL */
        char url[128];
        snprintf(url, sizeof(url), "http://%s:%d/api/firmware/latest",
                 s_config.server_ip, OTA_SERVER_PORT);

        /* --- Configure HTTP client --- */
        esp_http_client_config_t http_cfg = {
            .url = url,
            .timeout_ms = 10000,         /* 10s connect + response timeout */
            .buffer_size = OTA_BUF_SIZE,
        };
        esp_http_client_handle_t client = esp_http_client_init(&http_cfg);
        if (!client) {
            ESP_LOGW(TAG, "[OTA] Failed to init HTTP client");
            vTaskDelay(pdMS_TO_TICKS(RETRY_INTERVAL_SEC * 1000));
            continue;
        }

        /* Send our current firmware version so the server can compare */
        esp_http_client_set_header(client, "X-Firmware-Version", HEARTBEATZ_FW_VERSION);

        /* Build a simple node ID from the MAC address */
        uint8_t mac[6];
        esp_read_mac(mac, ESP_MAC_WIFI_STA);
        char node_id[20];
        snprintf(node_id, sizeof(node_id), "%02X:%02X:%02X:%02X:%02X",
                 mac[1], mac[2], mac[3], mac[4], mac[5]);
        esp_http_client_set_header(client, "X-Node-Id", node_id);

        /* Open the connection (sends GET request) */
        esp_err_t err = esp_http_client_open(client, 0);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "[OTA] HTTP open failed: %s", esp_err_to_name(err));
            esp_http_client_cleanup(client);
            vTaskDelay(pdMS_TO_TICKS(RETRY_INTERVAL_SEC * 1000));
            continue;
        }

        /* Read response headers */
        int content_length = esp_http_client_fetch_headers(client);
        int status_code = esp_http_client_get_status_code(client);

        ESP_LOGI(TAG, "[OTA] Server response: HTTP %d, content-length=%d",
                 status_code, content_length);

        if (status_code == 304) {
            /* Node is already up-to-date — no action needed */
            ESP_LOGI(TAG, "[OTA] Firmware is up-to-date (v%s)", HEARTBEATZ_FW_VERSION);
            esp_http_client_close(client);
            esp_http_client_cleanup(client);
            vTaskDelay(pdMS_TO_TICKS(CHECK_INTERVAL_SEC * 1000));
            continue;
        }

        if (status_code != 200 || content_length <= 0) {
            /* Server error or no firmware available */
            ESP_LOGW(TAG, "[OTA] No update available (HTTP %d)", status_code);
            esp_http_client_close(client);
            esp_http_client_cleanup(client);
            vTaskDelay(pdMS_TO_TICKS(RETRY_INTERVAL_SEC * 1000));
            continue;
        }

        /* ── New firmware available — begin OTA flash ── */
        ESP_LOGI(TAG, "[OTA] New firmware available (%d bytes) — starting OTA flash",
                 content_length);

        /* Signal that OTA is in progress (LED goes off, other tasks yield) */
        xEventGroupSetBits(s_system_events, OTA_IN_PROGRESS_BIT);
        led_status_set(LED_STATE_OTA);

        /* Find the next OTA partition (the one we're NOT currently running from) */
        const esp_partition_t *update_partition = esp_ota_get_next_update_partition(NULL);
        if (!update_partition) {
            ESP_LOGE(TAG, "[OTA] No OTA update partition found!");
            xEventGroupClearBits(s_system_events, OTA_IN_PROGRESS_BIT);
            led_status_set(LED_STATE_ERROR);
            esp_http_client_close(client);
            esp_http_client_cleanup(client);
            vTaskDelay(pdMS_TO_TICKS(RETRY_INTERVAL_SEC * 1000));
            continue;
        }

        ESP_LOGI(TAG, "[OTA] Writing to partition '%s' at offset 0x%lx",
                 update_partition->label, update_partition->address);

        /* Begin OTA write session */
        esp_ota_handle_t ota_handle;
        err = esp_ota_begin(update_partition, OTA_WITH_SEQUENTIAL_WRITES, &ota_handle);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "[OTA] esp_ota_begin failed: %s", esp_err_to_name(err));
            xEventGroupClearBits(s_system_events, OTA_IN_PROGRESS_BIT);
            led_status_set(LED_STATE_ERROR);
            esp_http_client_close(client);
            esp_http_client_cleanup(client);
            vTaskDelay(pdMS_TO_TICKS(RETRY_INTERVAL_SEC * 1000));
            continue;
        }

        /* --- Download and flash chunk by chunk --- */
        uint8_t *buf = malloc(OTA_BUF_SIZE);
        if (!buf) {
            ESP_LOGE(TAG, "[OTA] Failed to allocate download buffer");
            esp_ota_abort(ota_handle);
            xEventGroupClearBits(s_system_events, OTA_IN_PROGRESS_BIT);
            led_status_set(LED_STATE_ERROR);
            esp_http_client_close(client);
            esp_http_client_cleanup(client);
            vTaskDelay(pdMS_TO_TICKS(RETRY_INTERVAL_SEC * 1000));
            continue;
        }

        int total_read = 0;
        bool ota_success = true;

        while (total_read < content_length) {
            int read_len = esp_http_client_read(client, (char *)buf, OTA_BUF_SIZE);
            if (read_len < 0) {
                ESP_LOGE(TAG, "[OTA] HTTP read error at byte %d", total_read);
                ota_success = false;
                break;
            }
            if (read_len == 0) {
                /* Connection closed prematurely */
                if (total_read < content_length) {
                    ESP_LOGE(TAG, "[OTA] Connection closed early: %d/%d bytes",
                             total_read, content_length);
                    ota_success = false;
                }
                break;
            }

            /* Write this chunk to the OTA partition */
            err = esp_ota_write(ota_handle, buf, read_len);
            if (err != ESP_OK) {
                ESP_LOGE(TAG, "[OTA] Flash write failed at byte %d: %s",
                         total_read, esp_err_to_name(err));
                ota_success = false;
                break;
            }

            total_read += read_len;

            /* Log progress every ~100KB */
            if (total_read % (100 * 1024) < OTA_BUF_SIZE) {
                int pct = (int)((int64_t)total_read * 100 / content_length);
                ESP_LOGI(TAG, "[OTA] Progress: %d/%d bytes (%d%%)",
                         total_read, content_length, pct);
            }
        }

        free(buf);
        esp_http_client_close(client);
        esp_http_client_cleanup(client);

        if (!ota_success || total_read != content_length) {
            ESP_LOGE(TAG, "[OTA] Download incomplete (%d/%d bytes) — aborting",
                     total_read, content_length);
            esp_ota_abort(ota_handle);
            xEventGroupClearBits(s_system_events, OTA_IN_PROGRESS_BIT);
            led_status_set(LED_STATE_ERROR);
            vTaskDelay(pdMS_TO_TICKS(RETRY_INTERVAL_SEC * 1000));
            continue;
        }

        /* --- Finalize the OTA image --- */
        err = esp_ota_end(ota_handle);
        if (err != ESP_OK) {
            if (err == ESP_ERR_OTA_VALIDATE_FAILED) {
                ESP_LOGE(TAG, "[OTA] Image validation failed — bad checksum or format");
            } else {
                ESP_LOGE(TAG, "[OTA] esp_ota_end failed: %s", esp_err_to_name(err));
            }
            xEventGroupClearBits(s_system_events, OTA_IN_PROGRESS_BIT);
            led_status_set(LED_STATE_ERROR);
            vTaskDelay(pdMS_TO_TICKS(RETRY_INTERVAL_SEC * 1000));
            continue;
        }

        /* --- Set the new partition as the boot partition --- */
        err = esp_ota_set_boot_partition(update_partition);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "[OTA] Failed to set boot partition: %s", esp_err_to_name(err));
            xEventGroupClearBits(s_system_events, OTA_IN_PROGRESS_BIT);
            led_status_set(LED_STATE_ERROR);
            vTaskDelay(pdMS_TO_TICKS(RETRY_INTERVAL_SEC * 1000));
            continue;
        }

        ESP_LOGI(TAG, "╔══════════════════════════════════════════╗");
        ESP_LOGI(TAG, "║  OTA UPDATE COMPLETE — REBOOTING         ║");
        ESP_LOGI(TAG, "║  Downloaded %d bytes successfully        ║", total_read);
        ESP_LOGI(TAG, "║  New image on partition '%s'              ║", update_partition->label);
        ESP_LOGI(TAG, "╚══════════════════════════════════════════╝");

        /* Brief delay to let log messages flush, then reboot */
        vTaskDelay(pdMS_TO_TICKS(2000));
        esp_restart();
    }
}
