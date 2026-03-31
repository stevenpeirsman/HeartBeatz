// ==============================================================================
// Tests: Radar SSE Stream & REST API (SENSOR-02)
// ==============================================================================
// Validates:
//   - toUnifiedEvent() transformation from raw readings to unified model
//   - RadarStore: push, latest, engineering filtering, client management
//   - SSE broadcast to multiple clients with mode filtering
//   - connectRadarToStore() bridge wiring and cleanup
//   - Edge cases: empty store, invalid mode, stale data, client errors
// ==============================================================================

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';

import {
  toUnifiedEvent,
  RadarStore,
  connectRadarToStore,
  RADAR_EVENT_TYPE,
  RADAR_SOURCE,
  SSE_KEEPALIVE_MS,
  SSE_MAX_IDLE_MS,
} from './radar-sse.js';

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

/** Minimal basic-mode radar reading (as emitted by RadarService). */
function makeBasicReading(overrides = {}) {
  return {
    mode: 'basic',
    state: 'moving',
    movingDist: 150,
    movingEnergy: 72,
    stationaryDist: 0,
    stationaryEnergy: 0,
    detectionDist: 150,
    timestamp: 1711900000000,
    ...overrides,
  };
}

/** Engineering-mode radar reading with per-gate data. */
function makeEngineeringReading(overrides = {}) {
  return {
    mode: 'engineering',
    state: 'both',
    movingDist: 200,
    movingEnergy: 85,
    stationaryDist: 300,
    stationaryEnergy: 40,
    detectionDist: 300,
    maxMovingGate: 3,
    maxStationaryGate: 5,
    movingGateEnergy: [10, 50, 85, 30],
    stationaryGateEnergy: [5, 15, 25, 35, 40, 20],
    lightSensor: 128,
    outputPin: 1,
    timestamp: 1711900001000,
    ...overrides,
  };
}

/** Null-safe mock logger matching pino interface. */
function makeMockLogger() {
  return {
    child: () => makeMockLogger(),
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}

// ===========================================================================
// toUnifiedEvent()
// ===========================================================================

describe('toUnifiedEvent()', () => {
  it('transforms a basic reading into unified sensor event model', () => {
    const reading = makeBasicReading();
    const event = toUnifiedEvent(reading);

    assert.equal(event.type, RADAR_EVENT_TYPE);
    assert.equal(event.source, RADAR_SOURCE);
    assert.equal(event.timestamp, reading.timestamp);
    assert.equal(event.data.mode, 'basic');
    assert.equal(event.data.state, 'moving');
    assert.equal(event.data.movingDist, 150);
    assert.equal(event.data.movingEnergy, 72);
  });

  it('transforms an engineering reading into unified sensor event model', () => {
    const reading = makeEngineeringReading();
    const event = toUnifiedEvent(reading);

    assert.equal(event.type, RADAR_EVENT_TYPE);
    assert.equal(event.source, RADAR_SOURCE);
    assert.equal(event.timestamp, reading.timestamp);
    assert.equal(event.data.mode, 'engineering');
    assert.deepEqual(event.data.movingGateEnergy, [10, 50, 85, 30]);
    assert.equal(event.data.lightSensor, 128);
  });

  it('does not mutate the original reading (shallow copy)', () => {
    const reading = makeBasicReading();
    const event = toUnifiedEvent(reading);

    // Modifying event.data should not affect original
    event.data.movingDist = 9999;
    assert.equal(reading.movingDist, 150);
  });

  it('uses Date.now() when reading has no timestamp', () => {
    const reading = makeBasicReading({ timestamp: undefined });
    const before = Date.now();
    const event = toUnifiedEvent(reading);
    const after = Date.now();

    assert.ok(event.timestamp >= before);
    assert.ok(event.timestamp <= after);
  });

  it('preserves "none" state correctly', () => {
    const reading = makeBasicReading({ state: 'none', movingDist: 0, movingEnergy: 0 });
    const event = toUnifiedEvent(reading);
    assert.equal(event.data.state, 'none');
  });
});

// ===========================================================================
// RadarStore
// ===========================================================================

describe('RadarStore', () => {
  let store;

  beforeEach(() => {
    store = new RadarStore({ logger: makeMockLogger() });
  });

  afterEach(() => {
    store.reset();
  });

  // --- Basic push & retrieval ---

  it('starts with null latest and zero event count', () => {
    assert.equal(store.latest, null);
    assert.equal(store.latestEngineering, null);
    assert.equal(store.eventCount, 0);
    assert.equal(store.clientCount, 0);
  });

  it('stores basic reading as latest', () => {
    store.push(makeBasicReading());

    assert.notEqual(store.latest, null);
    assert.equal(store.latest.type, RADAR_EVENT_TYPE);
    assert.equal(store.latest.data.mode, 'basic');
    assert.equal(store.eventCount, 1);
  });

  it('stores engineering reading as both latest and latestEngineering', () => {
    store.push(makeEngineeringReading());

    assert.notEqual(store.latest, null);
    assert.notEqual(store.latestEngineering, null);
    assert.equal(store.latest.data.mode, 'engineering');
    assert.equal(store.latestEngineering.data.mode, 'engineering');
  });

  it('basic reading does not overwrite latestEngineering', () => {
    store.push(makeEngineeringReading({ timestamp: 1000 }));
    store.push(makeBasicReading({ timestamp: 2000 }));

    // Latest should be the basic reading
    assert.equal(store.latest.data.mode, 'basic');
    // Engineering should still be the earlier engineering reading
    assert.equal(store.latestEngineering.data.mode, 'engineering');
    assert.equal(store.latestEngineering.timestamp, 1000);
  });

  it('increments event count for each push', () => {
    store.push(makeBasicReading());
    store.push(makeBasicReading());
    store.push(makeEngineeringReading());
    assert.equal(store.eventCount, 3);
  });

  // --- SSE Client Management ---

  it('adds and removes SSE clients', () => {
    const client1 = () => {};
    const client2 = () => {};

    store.addClient(client1);
    assert.equal(store.clientCount, 1);

    store.addClient(client2);
    assert.equal(store.clientCount, 2);

    store.removeClient(client1);
    assert.equal(store.clientCount, 1);

    store.removeClient(client2);
    assert.equal(store.clientCount, 0);
  });

  it('removing a non-existent client is a no-op', () => {
    store.removeClient(() => {});
    assert.equal(store.clientCount, 0);
  });

  it('broadcasts events to all connected SSE clients', () => {
    const received1 = [];
    const received2 = [];

    store.addClient((event) => received1.push(event));
    store.addClient((event) => received2.push(event));

    store.push(makeBasicReading());

    assert.equal(received1.length, 1);
    assert.equal(received2.length, 1);
    assert.equal(received1[0].type, RADAR_EVENT_TYPE);
    assert.equal(received2[0].type, RADAR_EVENT_TYPE);
  });

  it('handles client send errors gracefully (does not crash)', () => {
    const goodReceived = [];

    // One client throws, other should still receive
    store.addClient(() => { throw new Error('broken client'); });
    store.addClient((event) => goodReceived.push(event));

    // Should not throw
    assert.doesNotThrow(() => store.push(makeBasicReading()));
    assert.equal(goodReceived.length, 1);
  });

  it('does not broadcast to clients after removal', () => {
    const received = [];
    const sendFn = (event) => received.push(event);

    store.addClient(sendFn);
    store.push(makeBasicReading());
    assert.equal(received.length, 1);

    store.removeClient(sendFn);
    store.push(makeBasicReading());
    assert.equal(received.length, 1); // Still 1, not 2
  });

  // --- Reset ---

  it('reset() clears all state', () => {
    store.push(makeBasicReading());
    store.push(makeEngineeringReading());
    store.addClient(() => {});

    store.reset();

    assert.equal(store.latest, null);
    assert.equal(store.latestEngineering, null);
    assert.equal(store.eventCount, 0);
    assert.equal(store.clientCount, 0);
  });

  // --- No logger ---

  it('works without a logger', () => {
    const noLogStore = new RadarStore();
    assert.doesNotThrow(() => {
      noLogStore.push(makeBasicReading());
      noLogStore.addClient(() => {});
      noLogStore.removeClient(() => {});
    });
    assert.equal(noLogStore.eventCount, 1);
  });
});

// ===========================================================================
// connectRadarToStore()
// ===========================================================================

describe('connectRadarToStore()', () => {
  it('bridges RadarService "reading" events to RadarStore', () => {
    const fakeRadar = new EventEmitter();
    const store = new RadarStore();

    connectRadarToStore(fakeRadar, store, makeMockLogger());

    // Emit a reading on the fake radar
    fakeRadar.emit('reading', makeBasicReading());

    assert.equal(store.eventCount, 1);
    assert.equal(store.latest.data.mode, 'basic');
  });

  it('bridges engineering readings correctly', () => {
    const fakeRadar = new EventEmitter();
    const store = new RadarStore();

    connectRadarToStore(fakeRadar, store);

    fakeRadar.emit('reading', makeEngineeringReading());

    assert.equal(store.eventCount, 1);
    assert.equal(store.latestEngineering.data.mode, 'engineering');
  });

  it('cleanup function removes the listener', () => {
    const fakeRadar = new EventEmitter();
    const store = new RadarStore();

    const cleanup = connectRadarToStore(fakeRadar, store);

    fakeRadar.emit('reading', makeBasicReading());
    assert.equal(store.eventCount, 1);

    // Cleanup — remove listener
    cleanup();

    fakeRadar.emit('reading', makeBasicReading());
    assert.equal(store.eventCount, 1); // Should NOT have increased
  });

  it('works without a logger', () => {
    const fakeRadar = new EventEmitter();
    const store = new RadarStore();

    assert.doesNotThrow(() => {
      const cleanup = connectRadarToStore(fakeRadar, store);
      fakeRadar.emit('reading', makeBasicReading());
      cleanup();
    });
  });

  it('handles multiple readings in sequence', () => {
    const fakeRadar = new EventEmitter();
    const store = new RadarStore();

    connectRadarToStore(fakeRadar, store, makeMockLogger());

    for (let i = 0; i < 100; i++) {
      fakeRadar.emit('reading', makeBasicReading({ timestamp: 1000 + i }));
    }

    assert.equal(store.eventCount, 100);
    assert.equal(store.latest.timestamp, 1099);
  });

  it('SSE clients receive bridged events', () => {
    const fakeRadar = new EventEmitter();
    const store = new RadarStore();
    const received = [];

    connectRadarToStore(fakeRadar, store, makeMockLogger());
    store.addClient((event) => received.push(event));

    fakeRadar.emit('reading', makeBasicReading());

    assert.equal(received.length, 1);
    assert.equal(received[0].type, RADAR_EVENT_TYPE);
    assert.equal(received[0].source, RADAR_SOURCE);
  });
});

// ===========================================================================
// Constants
// ===========================================================================

describe('Constants', () => {
  it('RADAR_EVENT_TYPE matches unified event model convention', () => {
    assert.equal(RADAR_EVENT_TYPE, 'radar-reading');
  });

  it('RADAR_SOURCE matches sensor source convention', () => {
    assert.equal(RADAR_SOURCE, 'radar');
  });

  it('SSE_KEEPALIVE_MS is 30 seconds', () => {
    assert.equal(SSE_KEEPALIVE_MS, 30_000);
  });

  it('SSE_MAX_IDLE_MS is 5 minutes', () => {
    assert.equal(SSE_MAX_IDLE_MS, 5 * 60 * 1000);
  });
});

// ===========================================================================
// Integration: Full event flow (Radar → Store → SSE Clients)
// ===========================================================================

describe('Integration: Full event flow', () => {
  it('routes basic and engineering readings to appropriate SSE clients', () => {
    const fakeRadar = new EventEmitter();
    const store = new RadarStore({ logger: makeMockLogger() });
    const allEvents = [];
    const engineeringOnly = [];

    connectRadarToStore(fakeRadar, store, makeMockLogger());

    // Client that receives everything
    store.addClient((event) => allEvents.push(event));

    // Simulate mode filtering as the SSE endpoint would do
    store.addClient((event) => {
      if (event.data?.mode === 'engineering') {
        engineeringOnly.push(event);
      }
    });

    // Emit mixed readings
    fakeRadar.emit('reading', makeBasicReading({ timestamp: 1 }));
    fakeRadar.emit('reading', makeEngineeringReading({ timestamp: 2 }));
    fakeRadar.emit('reading', makeBasicReading({ timestamp: 3 }));
    fakeRadar.emit('reading', makeEngineeringReading({ timestamp: 4 }));

    assert.equal(allEvents.length, 4);
    assert.equal(engineeringOnly.length, 2);
    assert.equal(engineeringOnly[0].timestamp, 2);
    assert.equal(engineeringOnly[1].timestamp, 4);
  });

  it('preserves full reading data through the pipeline', () => {
    const fakeRadar = new EventEmitter();
    const store = new RadarStore();
    const received = [];

    connectRadarToStore(fakeRadar, store);
    store.addClient((event) => received.push(event));

    const engReading = makeEngineeringReading();
    fakeRadar.emit('reading', engReading);

    const event = received[0];
    assert.equal(event.data.maxMovingGate, 3);
    assert.equal(event.data.maxStationaryGate, 5);
    assert.deepEqual(event.data.movingGateEnergy, [10, 50, 85, 30]);
    assert.deepEqual(event.data.stationaryGateEnergy, [5, 15, 25, 35, 40, 20]);
    assert.equal(event.data.lightSensor, 128);
    assert.equal(event.data.outputPin, 1);
  });

  it('handles rapid bursts without data loss', () => {
    const fakeRadar = new EventEmitter();
    const store = new RadarStore();
    const received = [];

    connectRadarToStore(fakeRadar, store);
    store.addClient((event) => received.push(event));

    // Simulate 10Hz burst for 1 second
    for (let i = 0; i < 10; i++) {
      fakeRadar.emit('reading', makeBasicReading({ timestamp: 1000 + i * 100 }));
    }

    assert.equal(received.length, 10);
    assert.equal(store.eventCount, 10);
    assert.equal(store.latest.timestamp, 1900);
  });
});
