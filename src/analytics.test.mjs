import test from 'node:test';
import assert from 'node:assert/strict';

import {
  rollingBaseline,
  deviation,
  strainTargetFor,
  acwr,
  sleepDebtSeries,
  anomaly,
  periodCompare,
} from './analytics.mjs';

// -----------------------------------------------------------------------
// Fixture helpers
// -----------------------------------------------------------------------
const BASE = '2026-02-10'; // fixed "today" for deterministic fixtures

function addDays(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// n days ago, relative to BASE (0 = today/newest)
function dAgo(n) {
  return addDays(BASE, -n);
}

// Recursively assert no NaN appears anywhere in a value.
function assertNoNaN(value, path = 'root') {
  if (typeof value === 'number') {
    assert.ok(!Number.isNaN(value), `NaN found at ${path}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoNaN(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoNaN(v, `${path}.${k}`);
  }
}

// 29 days of recovery (day0=newest .. day28=oldest), rhr baseline ~59.5
// with some nulls sprinkled in, day0 value overridable.
function buildRecovery({ day0Rhr = 60, day0Hrv = 70, day0SkinTempC = 33.4, includeNulls = true } = {}) {
  const pattern = [58, 59, 60, 61, 60, 59, 58, 60, 61, 59, 60, 58, 59, 60, 61, 59, 60, 58, 59, 60, 59, 60, 58, 59, 60, 61, 59, 60];
  const skinPattern = [33.3, 33.4, 33.5, 33.4, 33.3, 33.4, 33.5, 33.4, 33.3, 33.4, 33.5, 33.4, 33.3, 33.4, 33.5, 33.4, 33.3, 33.4, 33.5, 33.4, 33.3, 33.4, 33.5, 33.4, 33.3, 33.4, 33.5, 33.4];
  const hrvPattern = [68, 70, 72, 70, 68, 70, 72, 70, 68, 70, 72, 70, 68, 70, 72, 70, 68, 70, 72, 70, 68, 70, 72, 70, 68, 70, 72, 70];
  const records = [];
  records.push({
    date: dAgo(0),
    score: 55,
    rhr: day0Rhr,
    hrv: day0Hrv,
    spo2: 97,
    skinTempC: day0SkinTempC,
    calibrating: false,
  });
  for (let i = 1; i <= 28; i++) {
    const rhr = includeNulls && i % 7 === 0 ? null : pattern[i - 1];
    records.push({
      date: dAgo(i),
      score: 60,
      rhr,
      hrv: hrvPattern[i - 1],
      spo2: 97,
      skinTempC: skinPattern[i - 1],
      calibrating: false,
    });
  }
  return records;
}

// -----------------------------------------------------------------------
// Null tolerance
// -----------------------------------------------------------------------
test('null-tolerant fields never produce NaN across all analytics fns', () => {
  const recovery = buildRecovery();
  // Blank out some fields entirely to exercise "no usable value" paths.
  recovery[3].rhr = null;
  recovery[3].hrv = null;
  recovery[3].skinTempC = null;

  const sleep = [
    { date: dAgo(0), performancePct: null, durationMin: null, needMin: 480, debtMin: null, respiratoryRateBpm: null, efficiencyPct: 90, consistencyPct: 80, stages: { deepMin: null, remMin: null, lightMin: null, awakeMin: null }, start: null, end: null, naps: 0 },
    { date: dAgo(1), performancePct: 80, durationMin: 420, needMin: 460, debtMin: 40, respiratoryRateBpm: 15.5, efficiencyPct: 90, consistencyPct: 80, stages: { deepMin: 60, remMin: 90, lightMin: 240, awakeMin: 30 }, start: null, end: null, naps: 0 },
    { date: dAgo(2), performancePct: null, durationMin: 400, needMin: null, debtMin: null, respiratoryRateBpm: 16, efficiencyPct: null, consistencyPct: null, stages: { deepMin: 50, remMin: 80, lightMin: 230, awakeMin: 40 }, start: null, end: null, naps: 0 },
  ];

  const cycles = [
    { date: dAgo(0), strain: null, kilojoules: null, avgHr: null, maxHr: null },
    { date: dAgo(1), strain: 10, kilojoules: 1500, avgHr: 90, maxHr: 150 },
  ];

  assertNoNaN(rollingBaseline(recovery, 'rhr'), 'rollingBaseline');
  assertNoNaN(deviation(recovery, 'rhr'), 'deviation(rhr)');
  assertNoNaN(deviation(recovery, 'skinTempC'), 'deviation(skinTempC)');
  assertNoNaN(deviation([], 'rhr'), 'deviation(empty)');
  assertNoNaN(strainTargetFor(null), 'strainTargetFor(null)');
  assertNoNaN(strainTargetFor(NaN), 'strainTargetFor(NaN)');
  assertNoNaN(strainTargetFor(75), 'strainTargetFor(75)');
  assertNoNaN(acwr(cycles), 'acwr(short)');
  assertNoNaN(acwr([]), 'acwr(empty)');
  assertNoNaN(sleepDebtSeries(sleep), 'sleepDebtSeries');
  assertNoNaN(anomaly({ recovery, sleep }), 'anomaly');
  assertNoNaN(anomaly({ recovery: [], sleep: [] }), 'anomaly(empty)');
  assertNoNaN(periodCompare({ recovery, sleep, cycles }), 'periodCompare');
  assertNoNaN(periodCompare({ recovery: [], sleep: [], cycles: [] }), 'periodCompare(empty)');
});

test('rollingBaseline excludes nulls from stats and excludes the record itself', () => {
  const recovery = buildRecovery({ includeNulls: true });
  const baselines = rollingBaseline(recovery, 'rhr', { days: 28 });
  // Newest record's baseline should be built only from the 28 trailing
  // days (i=1..28), with nulls skipped -> n = 28 - 4 (four multiples of 7).
  const newest = baselines[0];
  assert.equal(newest.date, dAgo(0));
  assert.equal(newest.n, 24);
  assert.ok(newest.mean > 58 && newest.mean < 61);
  assert.ok(newest.sd > 0);
});

test('deviation returns null z/pctDelta with insufficient or zero-spread baseline', () => {
  const records = [
    { date: dAgo(0), rhr: 60 },
    { date: dAgo(1), rhr: 60 },
  ];
  const dev = deviation(records, 'rhr', { days: 28 });
  // Only one baseline point (n=1) -> sd is null -> z must be null, not NaN.
  assert.equal(dev.value, 60);
  assert.equal(dev.z, null);
  assertNoNaN(dev);
});

// -----------------------------------------------------------------------
// strainTargetFor
// -----------------------------------------------------------------------
test('strainTargetFor labels and clamps as documented', () => {
  const low = strainTargetFor(5); // center = 0.05*21*0.85 ~ 0.89 -> take it easy
  assert.equal(low.label, 'Take it easy');
  assert.equal(low.low, 0); // clamped at 0

  const mid = strainTargetFor(60); // center = 0.6*21*0.85 = 10.71 -> maintain
  assert.equal(mid.label, 'Maintain');
  assert.ok(mid.center > 8 && mid.center <= 14);

  const high = strainTargetFor(100); // center = 21*0.85 = 17.85 -> push
  assert.equal(high.label, 'Push');
  assert.ok(high.high <= 21);

  assert.deepEqual(strainTargetFor(null), { low: null, high: null, center: null, label: null });
});

// -----------------------------------------------------------------------
// acwr zones
// -----------------------------------------------------------------------
function buildCycles(recentStrain, olderStrain, { recentDays = 7, totalDays = 28 } = {}) {
  const cycles = [];
  for (let i = 0; i < totalDays; i++) {
    cycles.push({
      date: dAgo(i),
      strain: i < recentDays ? recentStrain : olderStrain,
      kilojoules: 1000,
      avgHr: 90,
      maxHr: 150,
    });
  }
  return cycles;
}

test('acwr: overreaching zone when acute >> chronic', () => {
  const cycles = buildCycles(18, 8);
  const result = acwr(cycles);
  // acute7 = 18; chronic28 = (7*18 + 21*8)/28 = 10.5; ratio = 18/10.5 ~ 1.71
  assert.equal(result.acute7, 18);
  assert.equal(result.chronic28, 10.5);
  assert.equal(result.ratio, 1.71);
  assert.equal(result.zone, 'overreaching');
});

test('acwr: optimal zone when acute ~= chronic', () => {
  const cycles = buildCycles(10.5, 10);
  const result = acwr(cycles);
  assert.equal(result.zone, 'optimal');
  assert.ok(result.ratio >= 0.8 && result.ratio <= 1.3);
});

test('acwr: undertraining zone when acute << chronic', () => {
  const cycles = buildCycles(5, 12);
  const result = acwr(cycles);
  assert.equal(result.zone, 'undertraining');
  assert.ok(result.ratio < 0.8);
});

test('acwr: insufficient data below 14 days', () => {
  const cycles = buildCycles(10, 10, { totalDays: 10 });
  const result = acwr(cycles);
  assert.deepEqual(result, { insufficient: true });
  assert.deepEqual(acwr([]), { insufficient: true });
});

// -----------------------------------------------------------------------
// sleepDebtSeries
// -----------------------------------------------------------------------
test('sleepDebtSeries computes trailing 7-day cumulative debt, null-safe', () => {
  const sleep = [
    { date: dAgo(0), debtMin: 20 },
    { date: dAgo(1), debtMin: null },
    { date: dAgo(2), debtMin: 30 },
    { date: dAgo(3), debtMin: 10 },
  ];
  const series = sleepDebtSeries(sleep);
  assert.equal(series[0].date, dAgo(0));
  assert.equal(series[0].debtMin, 20);
  // Sum of debtMin over trailing 7 days ending day0, skipping the null day1:
  // 20 (day0) + 30 (day2) + 10 (day3) = 60
  assert.equal(series[0].cumulative7dMin, 60);
  assert.equal(series[1].debtMin, null);
});

// -----------------------------------------------------------------------
// anomaly
// -----------------------------------------------------------------------
test('anomaly flags when rhr and skinTempC both spike', () => {
  const recovery = buildRecovery({ day0Rhr: 70, includeNulls: false }); // clear rhr spike
  recovery[0].skinTempC = 35.5; // clear skin temp spike vs ~33.4 baseline
  const sleep = [];
  const result = anomaly({ recovery, sleep }, { days: 28 });
  assert.equal(result.score, 2);
  assert.equal(result.flagged, true);
  assert.ok(result.reasons.length === 2);
  assert.match(result.reasons[0], /RHR/);
});

test('anomaly does not flag on normal values', () => {
  const recovery = buildRecovery({ day0Rhr: 60, includeNulls: false });
  const sleep = [
    { date: dAgo(0), respiratoryRateBpm: 15.5 },
    { date: dAgo(1), respiratoryRateBpm: 15.4 },
    { date: dAgo(2), respiratoryRateBpm: 15.6 },
  ];
  const result = anomaly({ recovery, sleep }, { days: 28 });
  assert.equal(result.score, 0);
  assert.equal(result.flagged, false);
  assert.deepEqual(result.reasons, []);
});

test('anomaly: hrv drop counts toward rhr point when rhr is null', () => {
  const recovery = buildRecovery({ includeNulls: false });
  recovery[0].rhr = null;
  recovery[0].hrv = 40; // clear drop vs baseline of 70
  const result = anomaly({ recovery, sleep: [] }, { days: 28 });
  assert.equal(result.score, 1);
  assert.equal(result.flagged, false); // needs score >= 2
  assert.match(result.reasons[0], /HRV/);
});

// -----------------------------------------------------------------------
// periodCompare
// -----------------------------------------------------------------------
test('periodCompare computes this-7d vs prior-7d deltas', () => {
  const recovery = [];
  for (let i = 0; i < 14; i++) {
    recovery.push({ date: dAgo(i), score: i < 7 ? 60 : 50, rhr: 55, hrv: 70, spo2: 97, skinTempC: 33.4, calibrating: false });
  }
  const result = periodCompare({ recovery, sleep: [], cycles: [] }, { aDays: 7, bDays: 7 });
  assert.equal(result.recovery.a, 60);
  assert.equal(result.recovery.b, 50);
  assert.equal(result.recovery.delta, 10);
  assert.equal(result.recovery.pctDelta, 20);
});

test('periodCompare returns null metrics with no data at all', () => {
  const result = periodCompare({ recovery: [], sleep: [], cycles: [] });
  assert.deepEqual(result.recovery, { a: null, b: null, delta: null, pctDelta: null });
});
