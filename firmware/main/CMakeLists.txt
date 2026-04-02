# ==============================================================================
# HeartBeatz Sensor Node — Main Component CMakeLists.txt
# ==============================================================================
# Lists all source files and include directories for the main application
# component. ESP-IDF builds this as the primary application binary.

idf_component_register(
    SRCS
        "main.c"
        "wifi_csi.c"
        "udp_sender.c"
        "radar_ld2410s.c"
        "led_status.c"
        "nvs_config.c"
        "node_id.c"
        "led_strip_encoder.c"
    INCLUDE_DIRS
        "."
        "../include"
    REQUIRES
        driver
        esp_wifi
        esp_event
        esp_netif
        nvs_flash
        esp_timer
        lwip
        esp_http_client
)
