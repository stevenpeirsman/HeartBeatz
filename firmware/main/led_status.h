/**
 * ===========================================================================
 * LED Status Indicator — Header
 * ===========================================================================
 * Controls the on-board LED to communicate system state visually.
 * Uses PWM (LEDC) for smooth breathing/pulsing effects.
 *
 * States:
 *   CONNECTING — Fast blink (2Hz): WiFi connecting
 *   IDLE       — Slow breathe (0.5Hz): Connected, waiting for CSI
 *   STREAMING  — Steady pulse (1Hz): Actively streaming CSI data
 *   ERROR      — Rapid flash (5Hz): System error
 *   OTA        — LED off: OTA update in progress (avoid GPIO conflicts)
 */

#ifndef LED_STATUS_H
#define LED_STATUS_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * LED state modes — each produces a different visual pattern.
 */
typedef enum {
    LED_STATE_OFF = 0,      /**< LED completely off */
    LED_STATE_CONNECTING,   /**< Fast blink — WiFi connecting */
    LED_STATE_IDLE,         /**< Slow breathe — connected, idle */
    LED_STATE_STREAMING,    /**< Steady pulse — streaming data */
    LED_STATE_ERROR,        /**< Rapid flash — error state */
    LED_STATE_OTA,          /**< Off during OTA update */
} led_state_t;

/**
 * Initialize the LED GPIO pin and LEDC PWM channel.
 * Must be called before any other led_status_ functions.
 *
 * @param gpio_pin  GPIO number for the status LED
 */
void led_status_init(int gpio_pin);

/**
 * Set the current LED state. The visual pattern will change
 * on the next tick.
 *
 * @param state  Desired LED state
 */
void led_status_set(led_state_t state);

/**
 * Advance the LED animation by one frame.
 * Should be called at ~50Hz from the LED task.
 */
void led_status_tick(void);

#ifdef __cplusplus
}
#endif

#endif /* LED_STATUS_H */
