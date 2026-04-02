/**
 * node_id.h — Node identification via LED blink pattern.
 *
 * After WiFi connects the node asks the server "what number am I?" and then
 * blinks the built-in LED that many times every 30 seconds.
 */

#pragma once

#ifdef __cplusplus
extern "C" {
#endif

/**
 * FreeRTOS task entry point.
 * @param arg  Pointer to a null-terminated server IP string (must outlive task).
 */
void node_id_task(void *arg);

/**
 * Returns the 1-based node index (0 if not yet resolved).
 */
int node_id_get(void);

#ifdef __cplusplus
}
#endif
