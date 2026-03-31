// ==============================================================================
// Tests for shared/constants.js
// ==============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  NUM_SUBCARRIERS,
  NUM_BANDS,
  SUBCARRIER_BANDS,
  CSI_PAYLOAD_BYTES,
  BYTES_PER_SUBCARRIER,
} from './constants.js';

describe('Shared Constants', () => {
  it('NUM_SUBCARRIERS is 52 for HT20', () => {
    assert.equal(NUM_SUBCARRIERS, 52);
  });

  it('CSI_PAYLOAD_BYTES matches subcarriers × bytes per subcarrier', () => {
    assert.equal(CSI_PAYLOAD_BYTES, NUM_SUBCARRIERS * BYTES_PER_SUBCARRIER);
  });

  it('NUM_BANDS is 8', () => {
    assert.equal(NUM_BANDS, 8);
  });

  it('SUBCARRIER_BANDS has exactly NUM_BANDS entries', () => {
    assert.equal(SUBCARRIER_BANDS.length, NUM_BANDS);
  });

  it('SUBCARRIER_BANDS covers all 52 subcarriers without gaps', () => {
    // Verify contiguous coverage from 0 to 52
    for (let i = 0; i < SUBCARRIER_BANDS.length - 1; i++) {
      assert.equal(
        SUBCARRIER_BANDS[i].end,
        SUBCARRIER_BANDS[i + 1].start,
        `Gap between band ${i} and ${i + 1}`
      );
    }
    assert.equal(SUBCARRIER_BANDS[0].start, 0);
    assert.equal(SUBCARRIER_BANDS[SUBCARRIER_BANDS.length - 1].end, NUM_SUBCARRIERS);
  });

  it('SUBCARRIER_BANDS are immutable (frozen)', () => {
    assert.throws(() => {
      SUBCARRIER_BANDS.push({ start: 52, end: 58, label: 'bad' });
    });
  });

  it('Each band has a label string', () => {
    for (const band of SUBCARRIER_BANDS) {
      assert.equal(typeof band.label, 'string');
      assert.ok(band.label.length > 0);
    }
  });
});
