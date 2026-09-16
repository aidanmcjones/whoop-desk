import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { deriveIntervals, workoutPoints, buildSeries, initHrMonitor } from './hr-monitor.mjs';

const CYCLE_START = '2026-09-15T04:44:00.000Z';
const mins = (n) => new Date(new Date(CYCLE_START).getTime() + n * 60000).toISOString();

test('deriveIntervals recovers the bpm that occurred between two cumulative averages', () => {
  // 60 min at avg 60, then by 120 min the cumulative avg is 70.
  // Sum: 60*60 = 3600, 70*120 = 8400 -> the extra hour carried 4800/60 = 80 bpm.
  const out = deriveIntervals([
    { t: mins(60), elapsedMin: 60, avgHr: 60, cycleId: 1 },
    { t: mins(120), elapsedMin: 120, avgHr: 70, cycleId: 1 },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].bpm, 80);
  assert.equal(out[0].spanMin, 60);
  assert.equal(out[0].derived, true);
});

test('deriveIntervals holds a flat line when the cumulative average does not move', () => {
  const out = deriveIntervals([
    { t: mins(30), elapsedMin: 30, avgHr: 65, cycleId: 1 },
    { t: mins(60), elapsedMin: 60, avgHr: 65, cycleId: 1 },
    { t: mins(90), elapsedMin: 90, avgHr: 65, cycleId: 1 },
  ]);
  assert.deepEqual(out.map((o) => o.bpm), [65, 65]);
});

test('deriveIntervals skips cycle rollovers, too-short spans, and impossible values', () => {
  // different cycleId -> not comparable
  assert.equal(deriveIntervals([
    { t: mins(60), elapsedMin: 60, avgHr: 60, cycleId: 1 },
    { t: mins(5), elapsedMin: 5, avgHr: 60, cycleId: 2 },
  ]).length, 0);

  // span under the floor
  assert.equal(deriveIntervals([
    { t: mins(60), elapsedMin: 60.0, avgHr: 60, cycleId: 1 },
    { t: mins(60), elapsedMin: 60.3, avgHr: 61, cycleId: 1 },
  ]).length, 0);

  // implausible: cumulative avg jumps far too much for the elapsed gap
  assert.equal(deriveIntervals([
    { t: mins(60), elapsedMin: 60, avgHr: 60, cycleId: 1 },
    { t: mins(62), elapsedMin: 62, avgHr: 70, cycleId: 1 },
  ]).length, 0);
});

test('deriveIntervals sorts unordered input and tolerates missing fields', () => {
  const out = deriveIntervals([
    { t: mins(120), elapsedMin: 120, avgHr: 70, cycleId: 1 },
    { t: mins(60), elapsedMin: 60, avgHr: 60, cycleId: 1 },
    { t: mins(90), avgHr: null, cycleId: 1 },
    null,
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].bpm, 80);
});

test('workoutPoints returns only the requested day and keeps sport and max', () => {
  const pts = workoutPoints([
    { date: '2026-09-15', start: mins(200), avgHr: 109, maxHr: 146, durationMin: 47, sport: 'Dance' },
    { date: '2026-09-14', start: mins(10), avgHr: 100, maxHr: 130, durationMin: 20, sport: 'Run' },
    { date: '2026-09-15', start: mins(300), avgHr: null, sport: 'Walk' },
  ], '2026-09-15');
  assert.equal(pts.length, 1);
  assert.equal(pts[0].sport, 'Dance');
  assert.equal(pts[0].bpm, 109);
  assert.equal(pts[0].maxBpm, 146);
  assert.equal(pts[0].derived, false);
});

test('buildSeries reports warming up until a second reading arrives', () => {
  const one = buildSeries({
    samples: [{ t: mins(60), elapsedMin: 60, avgHr: 60, cycleId: 1 }],
    cycle: { avgHr: 60, maxHr: 120 },
    date: '2026-09-15',
    timeZone: 'UTC',
  });
  assert.equal(one.warmingUp, true);
  assert.equal(one.points.length, 0);
  assert.equal(one.cycleAvgHr, 60);
  assert.equal(one.cycleMaxHr, 120);

  const two = buildSeries({
    samples: [
      { t: mins(60), elapsedMin: 60, avgHr: 60, cycleId: 1 },
      { t: mins(120), elapsedMin: 120, avgHr: 70, cycleId: 1 },
    ],
    cycle: { avgHr: 70, maxHr: 145 },
    date: '2026-09-15',
    timeZone: 'UTC',
  });
  assert.equal(two.warmingUp, false);
  assert.equal(two.latestBpm, 80);
  assert.deepEqual(two.rangeBpm, { lo: 80, hi: 80 });
  assert.equal(two.sampleCount, 2);
});

test('buildSeries keeps only samples from the requested local day', () => {
  const s = buildSeries({
    samples: [
      { t: '2026-09-14T20:00:00Z', elapsedMin: 30, avgHr: 60, cycleId: 1 },
      { t: '2026-09-15T10:00:00Z', elapsedMin: 60, avgHr: 60, cycleId: 2 },
      { t: '2026-09-15T11:00:00Z', elapsedMin: 120, avgHr: 70, cycleId: 2 },
    ],
    date: '2026-09-15',
    timeZone: 'UTC',
  });
  assert.equal(s.sampleCount, 2);
  assert.equal(s.points.length, 1);
});

test('store records a reading, skips an unchanged one, and persists across reloads', async () => {
  const dir = path.join(os.tmpdir(), `whoop-hr-test-${process.pid}-${Date.now()}`);
  try {
    const store = await initHrMonitor({ dataDir: dir });
    const cycle = { id: 7, start: CYCLE_START, avgHr: 60, maxHr: 120 };

    const first = await store.record({ cycle, at: mins(60) });
    assert.equal(first.added, true);
    assert.equal(first.sample.elapsedMin, 60);

    // identical reading, moments later -> not recorded
    const dup = await store.record({ cycle, at: mins(60.2) });
    assert.equal(dup.added, false);

    const moved = await store.record({ cycle: { ...cycle, avgHr: 70 }, at: mins(120) });
    assert.equal(moved.added, true);

    const series = store.getSeries({ cycle: { avgHr: 70, maxHr: 120 }, date: '2026-09-15', timeZone: 'UTC' });
    assert.equal(series.latestBpm, 80);

    const reloaded = await initHrMonitor({ dataDir: dir });
    assert.equal(reloaded.listSamples().length, 2);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('store ignores a cycle with no heart rate yet', async () => {
  const dir = path.join(os.tmpdir(), `whoop-hr-test2-${process.pid}-${Date.now()}`);
  try {
    const store = await initHrMonitor({ dataDir: dir });
    assert.equal((await store.record({ cycle: { id: 1, start: CYCLE_START, avgHr: null } })).added, false);
    assert.equal((await store.record({ cycle: null })).added, false);
    assert.equal(store.listSamples().length, 0);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
