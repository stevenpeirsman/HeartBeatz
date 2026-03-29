/**
 * ===========================================================================
 * LED Status Indicator — Implementation
 * ===========================================================================
 * Uses the ESP32 LEDC (LED Controller) peripheral for smooth PWM-based
 * LED animations. Each state has a different pattern:
 *
 *   CONNECTING: Square wave at 2Hz (250ms on, 250ms off)
 *   IDLE:       Sine-wave breathing at 0.5Hz (soft glow)
 *   STREAMING:  Sine-wave pulse at 1Hz (steady heartbeat)
 *   ERROR:      Square wave at 5Hz (rapid flash)
 *   OFF/OTA:    Duty = 0 (LED off)
 *
 * The tick() function is called at ~50Hz and updates the PWM duty cycle
 * based on the current state and elapsed time.
 */

#include "led_status.h"

#include <stdbool.h>
#include <math.h>
#include "driver/ledc.h"
#include "esp_log.h"
#include "esp_timer.h"

static const char *TAG = "led";

/* ---------------------------------------------------------------------------
 * Configuration
 * --------------------------------------------------------------------------- */

/** LEDC channel and timer to use. */
#define LED_CHANNEL   LEDC_CHANNEL_0
#define LED_TIMER     LEDC_TIMER_0

/** PWM frequency (Hz). 5kHz is inaudible and gives 13-bit resolution. */
#define LED_PWM_FREQ  5000

/** PWM resolution (bits). 13 bits = 0-8191 duty range. */
#define LED_PWM_RES   LEDC_TIMER_13_BIT
#define LED_MAX_DUTY  8191

/* ---------------------------------------------------------------------------
 * Module State
 * --------------------------------------------------------------------------- */

static led_state_t s_current_state = LED_STATE_OFF;
static int s_gpio_pin = -1;
static bool s_initialized = false;

/* ---------------------------------------------------------------------------
 * Public API
 * --------------------------------------------------------------------------- */

void led_status_init(int gpio_pin)
{
    s_gpio_pin = gpio_pin;

    /* Configure LEDC timer */
    ledc_timer_config_t timer_cfg = {
        .speed_mode      = LEDC_LOW_SPEED_MODE,
        .timer_num       = LED_TIMER,
        .duty_resolution = LED_PWM_RES,
        .freq_hz         = LED_PWM_FREQ,
        .clk_cfg         = LEDC_AUTO_CLK,
    };
    ledc_timer_config(&timer_cfg);

    /* Configure LEDC channel */
    ledc_channel_config_t ch_cfg = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel    = LED_CHANNEL,
        .timer_sel  = LED_TIMER,
        .intr_type  = LEDC_INTR_DISABLE,
        .gpio_num   = gpio_pin,
        .duty       = 0,
        .hpoint     = 0,
    };
    ledc_channel_config(&ch_cfg);

    /* Enable fade functionality for smooth transitions */
    ledc_fade_func_install(0);

    s_initialized = true;
    ESP_LOGI(TAG, "LED initialized on GPIO %d (PWM %d Hz, %d-bit)",
             gpio_pin, LED_PWM_FREQ, 13);
}

void led_status_set(led_state_t state)
{
    s_current_state = state;
}

void led_status_tick(void)
{
    if (!s_initialized) return;

    /* Time in seconds (floating point for smooth animation) */
    float t = (float)(esp_timer_get_time() / 1000) / 1000.0f;
    uint32_t duty = 0;

    switch (s_current_state) {
    case LED_STATE_OFF:
    case LED_STATE_OTA:
        duty = 0;
        break;

    case LED_STATE_CONNECTING:
        /* Fast blink at 2Hz — sharp square wave */
        duty = (fmodf(t, 0.5f) < 0.25f) ? LED_MAX_DUTY : 0;
        break;

    case LED_STATE_IDLE:
        /* Slow breathing at ~0.5Hz — smooth sine wave */
        /* sin gives -1..1, we map to 0..1 then scale to duty range */
        duty = (uint32_t)((sinf(t * 3.14159f) + 1.0f) / 2.0f * LED_MAX_DUTY * 0.4f);
        break;

    case LED_STATE_STREAMING:
        /* Steady pulse at ~1Hz — heartbeat-like pattern */
        /* Double-bump pulse: fast up-down, pause, repeat */
        {
            float phase = fmodf(t, 1.0f);
            if (phase < 0.15f) {
                /* First bump (systole) */
                duty = (uint32_t)(sinf(phase / 0.15f * 3.14159f) * LED_MAX_DUTY);
            } else if (phase < 0.25f) {
                /* Brief pause */
                duty = 0;
            } else if (phase < 0.35f) {
                /* Second bump (diastole, smaller) */
                duty = (uint32_t)(sinf((phase - 0.25f) / 0.10f * 3.14159f) * LED_MAX_DUTY * 0.5f);
            } else {
                /* Rest */
                duty = 0;
            }
        }
        break;

    case LED_STATE_ERROR:
        /* Rapid flash at 5Hz */
        duty = (fmodf(t, 0.2f) < 0.1f) ? LED_MAX_DUTY : 0;
        break;
    }

    /* Apply duty cycle */
    ledc_set_duty(LEDC_LOW_SPEED_MODE, LED_CHANNEL, duty);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, LED_CHANNEL);
}
