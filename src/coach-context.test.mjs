import test from 'node:test';
import assert from 'node:assert/strict';
import * as analytics from './analytics.mjs';
import { buildCoachContext } from './coach-context.mjs';

const recovery = [
  { date: '2026-09-11', score: 22, rhr: 65, hrv: 43.9187, spo2: 96.27, skinTempC: 33.376 },
  { date: '2026-09-10', score: 61, rhr: 55, hrv: 80.2, spo2: 97.1, skinTempC: 33.4 },
  { date: '2026-09-09', score: 70, rhr: 53, hrv: 88.6, spo2: 97.0, skinTempC: 33.3 },
];
const sleep = [
  {
    date: '2026-09-11', performancePct: 38, durationMin: 423, needMin: 620, efficiencyPct: 82.87, consistencyPct: 51,
    respiratoryRateBpm: 16.5, debtMin: 128, stages: { deepMin: 99, remMin: 64, lightMin: 188, awakeMin: 73 },
    start: '2026-09-11T07:32:21.040Z', end: '2026-09-11T14:35:42.660Z', naps: 1,
  },
  {
    date: '2026-09-10', performancePct: 80, durationMin: 470, needMin: 560, efficiencyPct: 92, consistencyPct: 70,
    respiratoryRateBpm: 16.1, debtMin: 40, stages: { deepMin: 110, remMin: 90, lightMin: 240, awakeMin: 30 },
    start: '2026-09-10T05:00:00Z', end: '2026-09-10T13:20:00Z', naps: 0,
  },
];
const cycles = [
  { date: '2026-09-11', strain: 4.7219, kilojoules: 6091, avgHr: 68, maxHr: 129 },
  { date: '2026-09-10', strain: 11.2, kilojoules: 9000, avgHr: 74, maxHr: 160 },
];
const workouts = [
  { date: '2026-09-10', sport: 'Dance', start: '2026-09-11T03:11:00Z', durationMin: 47, strain: 6.25, avgHr: 109, maxHr: 146, kilojoules: 877, zones: { z1Min: 25, z2Min: 1, z3Min: 0, z4Min: 0, z5Min: 0 } },
];
const full = { profile: { firstName: 'A', heightM: 1.8, weightKg: 75, maxHr: 195 }, recovery, sleep, cycles, workouts };

test('buildCoachContext exposes full sleep detail with pretty durations and local times', () => {
  const ctx = buildCoachContext({ full, recent: full, analytics, now: new Date('2026-09-11T22:00:00-07:00'), timeZone: 'America/Los_Angeles' });
  const night = ctx.sleep[0];
  assert.equal(night.date, '2026-09-11');
  assert.equal(night.asleep, '7h 03m');
  assert.equal(night.need, '10h 20m');
  assert.equal(night.bedtime, 'Fri 12:32 AM');
  assert.equal(night.wakeTime, 'Fri 7:35 AM');
  assert.deepEqual(night.stages, { deep: '1h 39m', rem: '1h 04m', light: '3h 08m', awake: '1h 13m' });
  assert.equal(night.efficiencyPct, 83);
  assert.equal(night.naps, 1);
});

test('buildCoachContext rounds recovery and converts workout energy to calories', () => {
  const ctx = buildCoachContext({ full, recent: full, analytics, now: new Date('2026-09-11T22:00:00-07:00'), timeZone: 'America/Los_Angeles' });
  assert.equal(ctx.recovery[0].hrvMs, 43.9);
  assert.equal(ctx.recovery[0].recoveryPct, 22);
  assert.equal(ctx.workouts[0].calories, Math.round(877 / 4.184));
  assert.deepEqual(ctx.workouts[0].zonesMin, { z1: 25, z2: 1, z3: 0, z4: 0, z5: 0 });
  assert.equal(ctx.cycles[0].dayStrain, 4.7);
});

test('buildCoachContext includes baselines, today, and strain target', () => {
  const ctx = buildCoachContext({ full, recent: full, analytics, now: new Date('2026-09-11T22:00:00-07:00'), timeZone: 'America/Los_Angeles' });
  assert.equal(ctx.now.today, '2026-09-11');
  assert.equal(ctx.now.timeZone, 'America/Los_Angeles');
  assert.ok(ctx.baselines28d.hrvMs && typeof ctx.baselines28d.hrvMs.mean === 'number');
  assert.ok(ctx.strainTarget && typeof ctx.strainTarget.low === 'number');
  assert.equal(ctx.historyCoverage.days, 3);
});
