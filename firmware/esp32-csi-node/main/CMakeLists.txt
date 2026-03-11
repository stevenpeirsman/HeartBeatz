set(SRCS
    "main.c" "csi_collector.c" "stream_sender.c" "nvs_config.c"
    "edge_processing.c" "ota_update.c" "power_mgmt.c"
    "wasm_runtime.c" "wasm_upload.c" "rvf_parser.c"
)

set(REQUIRES "")

# ADR-045: AMOLED display support is now in a separate component
if(CONFIG_DISPLAY_ENABLE)
    list(APPEND REQUIRES "display")
endif()

idf_component_register(
    SRCS ${SRCS}
    INCLUDE_DIRS "."
    REQUIRES ${REQUIRES}
)
