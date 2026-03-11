set(SRCS "display_hal.c" "display_task.c" "display_ui.c")

if(CONFIG_DISPLAY_ENABLE)
    idf_component_register(
        SRCS ${SRCS}
        INCLUDE_DIRS "."
        REQUIRES esp_lcd esp_lcd_touch lvgl
    )
endif()
