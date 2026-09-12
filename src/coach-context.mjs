// Builds the data packet the coach reasons over. Pure function of already
// loaded history/analytics/journal data, so it is testable outside Electron.
//
// Design goals:
//   - Complete enough that any "break down X" question can be answered from
//     the packet alone (stages, efficiency, bed/wake times, zones, ...).
//   - Numbers rounded and times localized so the model does not have to.
//   - 28-day baselines for the key metrics, so "vs your usual" is grounded.
//
// Exports:
//   buildCoachContext({ full, recent, analytics, journalEntries, now, timeZone })

const round = (v, dp = 0) => (v == null || !Number.isFinite(Number(v)) ? null : Number(Number(v).toFixed(dp)));
const kjToKcal = (kj) => (kj == null ? null : Math.round(kj / 4.184));

function hm(min) {
  if (min == null || !Number.isFinite(min)) return null;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function localTime(iso, timeZone) {
  if (!iso) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function weekday(dateStr) {
  try {
    return new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${dateStr}T12:00:00Z`));
  } catch {
    return null;
  }
}

function baseline(analytics, records, field, dp = 1) {
  const d = analytics.deviation(records, field, { days: 28 });
  if (!d || d.mean == null) return null;
  return { mean: round(d.mean, dp), sd: d.sd == null ? null : round(d.sd, dp) };
}

export function buildCoachContext({
  full,
  recent,
  analytics,
  journalEntries = [],
  now = new Date(),
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
} = {}) {
  const recovery = (recent?.recovery || []).map((r) => ({
    date: r.date,
    day: weekday(r.date),
    recoveryPct: r.score,
    hrvMs: round(r.hrv, 1),
    rhrBpm: round(r.rhr),
    spo2Pct: round(r.spo2, 1),
    skinTempC: round(r.skinTempC, 1),
    ...(r.calibrating ? { calibrating: true } : {}),
  }));

  const sleep = (recent?.sleep || []).map((s) => ({
    date: s.date, // the morning this sleep ended; "last night" = newest record
    day: weekday(s.date),
    performancePct: round(s.performancePct),
    bedtime: localTime(s.start, timeZone),
    wakeTime: localTime(s.end, timeZone),
    asleep: hm(s.durationMin),
    asleepMin: round(s.durationMin),
    need: hm(s.needMin),
    needMin: round(s.needMin),
    debtMin: round(s.debtMin),
    efficiencyPct: round(s.efficiencyPct),
    consistencyPct: round(s.consistencyPct),
    respiratoryRateBpm: round(s.respiratoryRateBpm, 1),
    stages: s.stages
      ? {
          deep: hm(s.stages.deepMin),
          rem: hm(s.stages.remMin),
          light: hm(s.stages.lightMin),
          awake: hm(s.stages.awakeMin),
        }
      : null,
    naps: s.naps || 0,
  }));

  const cycles = (recent?.cycles || []).map((c) => ({
    date: c.date,
    day: weekday(c.date),
    dayStrain: round(c.strain, 1),
    calories: kjToKcal(c.kilojoules),
    avgHr: round(c.avgHr),
    maxHr: round(c.maxHr),
  }));

  const workouts = (recent?.workouts || []).map((w) => ({
    date: w.date,
    sport: w.sport,
    start: localTime(w.start, timeZone),
    duration: hm(w.durationMin),
    strain: round(w.strain, 1),
    avgHr: round(w.avgHr),
    maxHr: round(w.maxHr),
    calories: kjToKcal(w.kilojoules),
    zonesMin: w.zones
      ? { z1: w.zones.z1Min, z2: w.zones.z2Min, z3: w.zones.z3Min, z4: w.zones.z4Min, z5: w.zones.z5Min }
      : null,
  }));

  const baselines28d = {
    recoveryPct: baseline(analytics, full.recovery, 'score', 0),
    hrvMs: baseline(analytics, full.recovery, 'hrv', 1),
    rhrBpm: baseline(analytics, full.recovery, 'rhr', 1),
    spo2Pct: baseline(analytics, full.recovery, 'spo2', 1),
    skinTempC: baseline(analytics, full.recovery, 'skinTempC', 2),
    sleepPerformancePct: baseline(analytics, full.sleep, 'performancePct', 0),
    sleepAsleepMin: baseline(analytics, full.sleep, 'durationMin', 0),
    sleepEfficiencyPct: baseline(analytics, full.sleep, 'efficiencyPct', 0),
    respiratoryRateBpm: baseline(analytics, full.sleep, 'respiratoryRateBpm', 1),
    dayStrain: baseline(analytics, full.cycles, 'strain', 1),
  };

  const debtSeries = analytics.sleepDebtSeries(full.sleep || []);
  const sleepDebt7dMin = debtSeries.length ? debtSeries[debtSeries.length - 1].cumulative7dMin : null;
  const newestScore = (full.recovery || []).find((r) => r.score != null)?.score ?? null;
  const acwr = analytics.acwr(full.cycles || []);

  return {
    now: {
      localDateTime: new Intl.DateTimeFormat('en-US', {
        timeZone,
        weekday: 'long',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(now),
      timeZone,
      today: (() => {
        try {
          const p = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
          const get = (t) => p.find((x) => x.type === t)?.value;
          return `${get('year')}-${get('month')}-${get('day')}`;
        } catch {
          return now.toISOString().slice(0, 10);
        }
      })(),
    },
    profile: recent?.profile
      ? {
          firstName: recent.profile.firstName,
          heightM: round(recent.profile.heightM, 2),
          weightKg: round(recent.profile.weightKg, 1),
          maxHr: recent.profile.maxHr,
        }
      : null,
    historyCoverage: {
      oldestDate: full?.recovery?.length ? full.recovery[full.recovery.length - 1].date : null,
      days: full?.recovery?.length || 0,
    },
    recovery,
    sleep,
    cycles,
    workouts,
    baselines28d,
    sleepDebt7d: sleepDebt7dMin == null ? null : { min: round(sleepDebt7dMin), pretty: hm(sleepDebt7dMin) },
    acwr,
    strainTarget: analytics.strainTargetFor(newestScore),
    journal: journalEntries.map((e) => ({
      date: e.date,
      tags: e.tags,
      note: typeof e.note === 'string' && e.note.length > 400 ? `${e.note.slice(0, 400)}…` : e.note,
    })),
  };
}
