import test from 'node:test';
import assert from 'node:assert/strict';

import { cycleDate, normalizeCycle } from './whoop-client.mjs';

// Real records from Oct 13-14 2026 (America/Chicago, UTC-5), the case that
// left "today" with no strain.
const yesterday = {
  start: '2026-10-13T05:00:00.000Z', // midnight local
  end: '2026-10-14T04:26:08.710Z', //   11:26pm local, Oct 13
  score_state: 'SCORED',
  score: { strain: 8.27677 },
};
const today = {
  start: '2026-10-14T04:26:08.710Z', // 11:26pm local, Oct 13 — sleep onset
  end: null, //                         still in progress
  score_state: 'SCORED',
  score: { strain: 14.713504 },
};

test('a cycle that starts before midnight belongs to the next day', () => {
  assert.equal(cycleDate(today), '2026-10-14');
  assert.equal(normalizeCycle(today).strain, 14.713504);
});

test('consecutive cycles never share a date', () => {
  assert.equal(cycleDate(yesterday), '2026-10-13');
  assert.notEqual(cycleDate(yesterday), cycleDate(today));
});

test('an after-midnight bedtime still dates the day correctly', () => {
  // Asleep at 1:30am local on the 14th; the cycle that ends then is the 13th.
  const ended = { start: '2026-10-13T06:10:00.000Z', end: '2026-10-14T06:30:00.000Z' };
  const started = { start: '2026-10-14T06:30:00.000Z', end: null };
  assert.equal(cycleDate(ended), '2026-10-13');
  assert.equal(cycleDate(started), '2026-10-14');
});

test('falls back to end or created_at when start is missing', () => {
  assert.equal(cycleDate({ end: '2026-10-14T18:00:00.000Z' }), '2026-10-14');
  assert.equal(cycleDate({ created_at: '2026-10-14T18:00:00.000Z' }), '2026-10-14');
});

import { oldestUnsettledStart } from './history.mjs';

test('sync window reaches back to unfinished records, within the cap', () => {
  const now = Date.parse('2026-10-15T03:00:00Z');
  const store = {
    raw: {
      cycle: {
        a: { start: '2026-10-05T05:14:03.780Z', end: null }, // stale open cycle
        b: { start: '2026-10-14T04:26:08.710Z', end: null }, // today's
        c: { start: '2026-10-01T05:00:00Z', end: '2026-10-02T05:00:00Z', score_state: 'SCORED' },
        d: { start: '2026-06-01T05:00:00Z', end: null }, // beyond the 60-day cap
      },
      recovery: { r: { created_at: '2026-10-09T12:00:00Z', score_state: 'SCORED' } },
    },
  };
  assert.equal(oldestUnsettledStart(store, now), Date.parse('2026-10-05T05:14:03.780Z'));
  assert.equal(oldestUnsettledStart({ raw: { cycle: { c: store.raw.cycle.c } } }, now), null);
});
