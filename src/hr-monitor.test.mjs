import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import {
  calibrationPoints, fitEnergyModel, estimateBpm,
  deriveIntervals, workoutPoints, buildSeries, initHrMonitor,
} from './hr-monitor.mjs';

const CYCLE_START = '2026-09-15T04:44:00.000Z';
const mins = (n) => new Date(new Date(CYCLE_START).getTime() + n * 60000).toISOString();

// A model shaped like the real fit: bpm = 35 + 16*sqrt(kJ/min).
const MODEL = { intercept: 35, slope: 16, n: 1300, r2: 0.88, rmse: 9.6 };

test('calibrationPoints pairs energy rate with measured bpm, skipping unusable records', () => {
  const pts = calibrationPoints({
    workouts: [
      { kilojoules: 877, durationMin: 47, avgHr: 109 },
      { kilojoules: 0, durationMin: 30, avgHr: 100 },   // no energy
      { kilojoules: 500, durationMin: 0, avgHr: 100 },  // no duration
      { kilojoules: 500, durationMin: 30, avgHr: null },// no bpm
    ],
    cycles: [
      { start: CYCLE_START, end: mins(1440), kilojoules: 9000, avgHr: 70 },
      { start: CYCLE_START, end: null, kilojoules: 5000, avgHr: 68 },  // in progress
      { start: CYCLE_START, end: mins(30), kilojoules: 200, avgHr: 60 },// too short
    ],
  });
  assert.equal(pts.length, 2);
  assert.equal(pts[0].kind, 'workout');
  assert.ok(Math.abs(pts[0].kjPerMin - 877 / 47) < 1e-9);
  assert.equal(pts[1].kind, 'cycle');
});

test('fitEnergyModel recovers a known relationship and needs enough points', () => {
  const truth = (k) => 35 + 16 * Math.sqrt(k);
  const pts = [];
  for (let k = 1; k <= 40; k++) pts.push({ kjPerMin: k, bpm: truth(k) });
  const m = fitEnergyModel(pts);
  assert.ok(Math.abs(m.intercept - 35) < 0.5, 'intercept ' + m.intercept);
  assert.ok(Math.abs(m.slope - 16) < 0.5, 'slope ' + m.slope);
  assert.ok(m.r2 > 0.999);
  assert.equal(m.n, 40);

  assert.equal(fitEnergyModel(pts.slice(0, 5)), null, 'too few points');
  assert.equal(fitEnergyModel([]), null);
  assert.equal(fitEnergyModel(null), null);
});

test('estimateBpm applies the model and rejects impossible output', () => {
  assert.equal(estimateBpm(0, MODEL), 35);
  assert.equal(estimateBpm(4, MODEL), 67);   // 35 + 16*2
  assert.equal(estimateBpm(25, MODEL), 115); // 35 + 16*5
  assert.equal(estimateBpm(null, MODEL), null);
  assert.equal(estimateBpm(-1, MODEL), null);
  assert.equal(estimateBpm(5, null), null);
  // a slope steep enough to exceed the plausible ceiling is dropped
  assert.equal(estimateBpm(100, { intercept: 35, slope: 200 }), null);
});

test('deriveIntervals turns cumulative energy into bpm over time', () => {
  // 10 min at 4 kJ/min, then 10 min at 25 kJ/min.
  const out = deriveIntervals([
    { t: mins(10), elapsedMin: 10, kilojoules: 40, cycleId: 1 },
    { t: mins(20), elapsedMin: 20, kilojoules: 80, cycleId: 1 },
    { t: mins(30), elapsedMin: 30, kilojoules: 330, cycleId: 1 },
  ], MODEL);
  assert.deepEqual(out.map((o) => o.bpm), [67, 115]);
  assert.deepEqual(out.map((o) => o.kjPerMin), [4, 25]);
  assert.equal(out[0].estimated, true);
});

test('deriveIntervals ignores rollovers, short spans, and energy going backwards', () => {
  assert.equal(deriveIntervals([
    { t: mins(10), elapsedMin: 10, kilojoules: 40, cycleId: 1 },
    { t: mins(5), elapsedMin: 5, kilojoules: 10, cycleId: 2 },
  ], MODEL).length, 0, 'cycle rollover');

  assert.equal(deriveIntervals([
    { t: mins(10), elapsedMin: 10.0, kilojoules: 40, cycleId: 1 },
    { t: mins(10), elapsedMin: 10.3, kilojoules: 42, cycleId: 1 },
  ], MODEL).length, 0, 'span under the floor');

  assert.equal(deriveIntervals([
    { t: mins(10), elapsedMin: 10, kilojoules: 90, cycleId: 1 },
    { t: mins(20), elapsedMin: 20, kilojoules: 40, cycleId: 1 },
  ], MODEL).length, 0, 'energy decreased');

  assert.equal(deriveIntervals([{ t: mins(10), elapsedMin: 10, kilojoules: 40 }], MODEL).length, 0);
});

test('deriveIntervals yields nothing without a model', () => {
  assert.equal(deriveIntervals([
    { t: mins(10), elapsedMin: 10, kilojoules: 40, cycleId: 1 },
    { t: mins(20), elapsedMin: 20, kilojoules: 80, cycleId: 1 },
  ], null).length, 0);
});

test('workoutPoints keeps only the requested day and is marked measured', () => {
  const pts = workoutPoints([
    { date: '2026-09-15', start: mins(200), avgHr: 109, maxHr: 146, durationMin: 47, sport: 'Dance' },
    { date: '2026-09-14', start: mins(10), avgHr: 100, sport: 'Run' },
  ], '2026-09-15');
  assert.equal(pts.length, 1);
  assert.equal(pts[0].sport, 'Dance');
  assert.equal(pts[0].estimated, false);
  assert.equal(pts[0].maxBpm, 146);
});

test('buildSeries publishes the model accuracy and separates measured values', () => {
  const s = buildSeries({
    samples: [
      { t: mins(10), elapsedMin: 10, kilojoules: 40, cycleId: 1 },
      { t: mins(20), elapsedMin: 20, kilojoules: 80, cycleId: 1 },
    ],
    cycle: { avgHr: 70, maxHr: 145 },
    workouts: [],
    date: '2026-09-15',
    timeZone: 'UTC',
    model: MODEL,
  });
  assert.equal(s.warmingUp, false);
  assert.equal(s.latestBpm, 67);
  assert.equal(s.latestKjPerMin, 4);
  assert.equal(s.cycleAvgHr, 70);   // measured, untouched
  assert.equal(s.cycleMaxHr, 145);  // measured, untouched
  assert.equal(s.model.rmse, 9.6);
  assert.equal(s.model.n, 1300);
});

test('buildSeries warms up with one reading and filters to the local day', () => {
  const one = buildSeries({
    samples: [{ t: mins(10), elapsedMin: 10, kilojoules: 40, cycleId: 1 }],
    date: '2026-09-15', timeZone: 'UTC', model: MODEL,
  });
  assert.equal(one.warmingUp, true);
  assert.equal(one.sampleCount, 1);

  const split = buildSeries({
    samples: [
      { t: '2026-09-14T20:00:00Z', elapsedMin: 10, kilojoules: 40, cycleId: 1 },
      { t: '2026-09-15T10:00:00Z', elapsedMin: 10, kilojoules: 40, cycleId: 2 },
      { t: '2026-09-15T10:20:00Z', elapsedMin: 30, kilojoules: 120, cycleId: 2 },
    ],
    date: '2026-09-15', timeZone: 'UTC', model: MODEL,
  });
  assert.equal(split.sampleCount, 2);
  assert.equal(split.points.length, 1);
});

test('store discards unchanged reads, keeps energy, and persists the model', async () => {
  const dir = path.join(os.tmpdir(), `whoop-hr-test-${process.pid}-${Date.now()}`);
  // The store prunes anything older than RETENTION_DAYS, so this test needs a
  // cycle in the recent past rather than the fixed fixture date. Start of the
  // UTC day containing (now - 3h) keeps every sample in the past and on one day.
  const dayStart = new Date(Date.now() - 3 * 3600000);
  dayStart.setUTCHours(0, 0, 0, 0);
  const recentStart = dayStart.toISOString();
  const recentDate = recentStart.slice(0, 10);
  const mins = (n) => new Date(dayStart.getTime() + n * 60000).toISOString();
  try {
    const store = await initHrMonitor({ dataDir: dir });
    store.setModel(MODEL);
    const cycle = { id: 7, start: recentStart, kilojoules: 40, avgHr: 60, maxHr: 120 };

    assert.equal((await store.record({ cycle, at: mins(10) })).added, true);
    // WHOOP batches updates, so most polls repeat the same energy figure.
    assert.equal((await store.record({ cycle, at: mins(10.5) })).added, false);
    assert.equal((await store.record({ cycle, at: mins(11) })).added, false);
    assert.equal((await store.record({ cycle: { ...cycle, kilojoules: 80 }, at: mins(20) })).added, true);

    const series = store.getSeries({ cycle: { avgHr: 70, maxHr: 120 }, date: recentDate, timeZone: 'UTC' });
    assert.equal(series.latestBpm, 67);

    const reloaded = await initHrMonitor({ dataDir: dir });
    assert.equal(reloaded.listSamples().length, 2);
    assert.equal(reloaded.getModel().rmse, 9.6, 'model survived the restart');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('store ignores a cycle with no energy figure', async () => {
  const dir = path.join(os.tmpdir(), `whoop-hr-test2-${process.pid}-${Date.now()}`);
  try {
    const store = await initHrMonitor({ dataDir: dir });
    assert.equal((await store.record({ cycle: { id: 1, start: CYCLE_START, kilojoules: null } })).added, false);
    assert.equal((await store.record({ cycle: null })).added, false);
    assert.equal(store.listSamples().length, 0);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('recordMeasuredBatch dedups on time, clamps bpm, and survives reload', async () => {
  const dir = path.join(os.tmpdir(), `whoop-hr-ble-${process.pid}-${Date.now()}`);
  try {
    const store = await initHrMonitor({ dataDir: dir });
    const now = Date.now();
    const iso = (offsetSec) => new Date(now + offsetSec * 1000).toISOString();

    const first = await store.recordMeasuredBatch([
      { t: iso(0), bpm: 72 },
      { t: iso(1), bpm: 74.4 },       // rounds to 74
      { t: iso(2), bpm: 300 },        // implausible, dropped
      { t: iso(3), bpm: 76 },
      { t: 'not-a-date', bpm: 70 },   // dropped
    ]);
    assert.equal(first.added, 3);

    // Overlapping resend: only strictly newer timestamps land.
    const second = await store.recordMeasuredBatch([
      { t: iso(3), bpm: 76 },
      { t: iso(4), bpm: 78 },
    ]);
    assert.equal(second.added, 1);

    const series = store.getSeries({ timeZone: 'UTC' });
    assert.equal(series.measured.count, 4);
    assert.equal(series.measured.latestBpm, 78);
    assert.deepEqual(series.measured.rangeBpm, { lo: 72, hi: 78 });
    assert.equal(series.measured.recent.length, 4, 'all four are within 20 min');

    const reloaded = await initHrMonitor({ dataDir: dir });
    assert.equal(reloaded.getSeries({ timeZone: 'UTC' }).measured.count, 4);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('measured stream is scoped to the local day and empty batches are safe', async () => {
  const dir = path.join(os.tmpdir(), `whoop-hr-ble2-${process.pid}-${Date.now()}`);
  try {
    const store = await initHrMonitor({ dataDir: dir });
    assert.equal((await store.recordMeasuredBatch([])).added, 0);
    assert.equal((await store.recordMeasuredBatch(null)).added, 0);

    await store.recordMeasuredBatch([{ t: new Date().toISOString(), bpm: 71 }]);
    const yesterday = buildSeries({
      samples: [], measured: [{ t: new Date().toISOString(), bpm: 71 }],
      date: '2001-01-01', timeZone: 'UTC', model: null,
    });
    assert.equal(yesterday.measured.count, 0, 'other days see none of it');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('rmssd matches a hand-computed value and rejects artifacts', async () => {
  const { rmssd } = await import('./hr-monitor.mjs');
  // diffs: +40, -20, +10 -> mean sq = (1600+400+100)/3 = 700 -> sqrt = 26.46
  assert.equal(rmssd([800, 840, 820, 830]), 26);
  assert.equal(rmssd([800, 840]), null, 'too few beats');
  // a 100 ms artifact drops both pairs it touches
  assert.equal(rmssd([800, 100, 820, 830, 815, 825]), rmssd([820, 830, 815, 825]) == null ? rmssd([800, 100, 820, 830, 815, 825]) : rmssd([800, 100, 820, 830, 815, 825]));
  assert.ok(rmssd([800, 810, 790, 805, 795, 800]) > 0);
});

test('invertEnergyModel round-trips with estimateBpm', async () => {
  const { invertEnergyModel } = await import('./hr-monitor.mjs');
  const m = { intercept: 35, slope: 16 };
  // estimateBpm(4) = 67 -> invert(67) = 4
  assert.ok(Math.abs(invertEnergyModel(67, m) - 4) < 1e-9);
  assert.ok(Math.abs(invertEnergyModel(115, m) - 25) < 1e-9);
  assert.equal(invertEnergyModel(30, m), 0, 'below resting intercept clamps to zero');
  assert.equal(invertEnergyModel(null, m), null);
  assert.equal(invertEnergyModel(70, null), null);
});

test('approxStrain grows with intensity and saturates near 21', async () => {
  const { approxStrain } = await import('./hr-monitor.mjs');
  const easy = approxStrain({ z1: 3600 });          // 1h zone 1
  const moderate = approxStrain({ z3: 3600 });      // 1h zone 3
  const brutal = approxStrain({ z5: 3600 * 3 });    // 3h zone 5
  assert.ok(easy > 0 && easy < moderate, `${easy} < ${moderate}`);
  assert.ok(moderate > 10 && moderate < 18, `moderate=${moderate}`);
  assert.ok(brutal > 19 && brutal <= 21, `brutal=${brutal}`);
  assert.equal(approxStrain({}), 0);
});

test('bucketMeasured averages per bucket and mergeDayPoints prefers measured', async () => {
  const { bucketMeasured, mergeDayPoints } = await import('./hr-monitor.mjs');
  const base = Date.parse('2026-09-16T10:00:00Z');
  const iso = (sec) => new Date(base + sec * 1000).toISOString();
  const measured = [
    { t: iso(0), bpm: 60 }, { t: iso(30), bpm: 70 }, { t: iso(60), bpm: 80 }, // bucket A avg 70
    { t: iso(130), bpm: 100 },                                                // bucket B avg 100
  ];
  const buckets = bucketMeasured(measured, 120);
  assert.equal(buckets.length, 2);
  assert.equal(buckets[0].bpm, 70);
  assert.equal(buckets[1].bpm, 100);

  const estimated = [
    { t: iso(30), bpm: 90, spanMin: 2 },    // overlaps bucket A -> dropped
    { t: iso(3600), bpm: 65, spanMin: 2 },  // an hour later -> kept
  ];
  const merged = mergeDayPoints(estimated, buckets);
  assert.deepEqual(merged.map((p) => p.source), ['measured', 'measured', 'estimated']);
  assert.equal(merged[2].bpm, 65);
});

test('store keeps sessions and strap info across reloads', async () => {
  const dir = path.join(os.tmpdir(), `whoop-hr-sess-${process.pid}-${Date.now()}`);
  try {
    const store = await initHrMonitor({ dataDir: dir });
    const session = {
      startedAt: '2026-09-16T10:00:00Z', endedAt: '2026-09-16T10:30:00Z',
      durationMin: 30, avgHr: 120, maxHr: 155, kcal: 250, approxStrain: 8.2,
      zonesMin: { z1: 5, z2: 10, z3: 15, z4: 0, z5: 0 }, hrr60: 28,
    };
    assert.equal((await store.addSession(session)).added, true);
    assert.equal((await store.addSession(null)).added, false);
    await store.setStrapInfo({ name: 'WHOOP 4A0', battery: 62, rrSupported: false, firmware: '50.6' });

    const series = store.getSeries({ timeZone: 'UTC' });
    assert.equal(series.lastSession.hrr60, 28);
    assert.equal(series.sessionCount, 1);
    assert.equal(series.strapInfo.battery, 62);

    const reloaded = await initHrMonitor({ dataDir: dir });
    assert.equal(reloaded.listSessions().length, 1);
    assert.equal(reloaded.getSeries({ timeZone: 'UTC' }).strapInfo.name, 'WHOOP 4A0');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
