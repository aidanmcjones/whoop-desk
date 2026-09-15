// Pure-logic analytics engine for whoop-desk.
//
// Node >= 20, ESM, no npm dependencies. Every export here is a pure
// function: no I/O, no mutation of inputs, no Date.now()/timezone lookups
// beyond simple calendar-day arithmetic on the "YYYY-MM-DD" date strings
// already present on records.
//
// Null-tolerance contract: any numeric field may be null. Nulls (and
// non-finite numbers) are skipped when computing stats; a function that
// cannot produce a meaningful number returns null/empty for that field
// rather than NaN. NaN must never appear anywhere in returned output.
//
// Exports:
//   - rollingBaseline(records, field, { days = 28 } = {}) -> [{ date, mean, sd, n }]
//   - deviation(records, field, { days = 28 } = {}) -> { value, mean, sd, z, pctDelta }
//   - strainTargetFor(recoveryScore) -> { low, high, center, label }
//   - acwr(cycles) -> { acute7, chronic28, ratio, zone } | { insufficient: true }
//   - sleepDebtSeries(sleep) -> [{ date, debtMin, cumulative7dMin }]
//   - anomaly({ recovery, sleep }, { days = 28 } = {}) -> { flagged, score, reasons }
//   - periodCompare({ recovery, sleep, cycles }, { aDays = 7, bDays = 7 } = {}) ->
//       { recovery, hrv, rhr, sleepHours, strain } each { a, b, delta, pctDelta }

// -----------------------------------------------------------------------
// Small internal helpers
// -----------------------------------------------------------------------

function isNum(v) {
  return v != null && typeof v === 'number' && Number.isFinite(v);
}

function round(value, decimals = 2) {
  if (!isNum(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function avg(values) {
  const vals = values.filter(isNum);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// Sample mean/sd (n-1 denominator) over the finite values in `values`.
// sd is null (not 0, not NaN) when fewer than 2 usable values exist.
function computeStats(values) {
  const vals = values.filter(isNum);
  const n = vals.length;
  if (n === 0) return { mean: null, sd: null, n: 0 };
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  if (n === 1) return { mean, sd: null, n };
  const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return { mean, sd: Math.sqrt(Math.max(0, variance)), n };
}

// Calendar-day arithmetic on "YYYY-MM-DD" strings, done in UTC so it's
// immune to DST shifts.
function addDays(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function byDateAsc(a, b) {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
}

function withDate(records) {
  return (records || []).filter((r) => r && r.date);
}

// -----------------------------------------------------------------------
// rollingBaseline
// -----------------------------------------------------------------------
export function rollingBaseline(records, field, { days = 28 } = {}) {
  const recs = withDate(records);
  const ascending = [...recs].sort(byDateAsc);

  const baselineByDate = new Map();
  for (let i = 0; i < ascending.length; i++) {
    const curDate = ascending[i].date;
    const windowStart = addDays(curDate, -days);
    const vals = [];
    for (let j = i - 1; j >= 0; j--) {
      const other = ascending[j];
      if (other.date < windowStart) break; // dates only decrease walking backward
      vals.push(other[field]);
    }
    const { mean, sd, n } = computeStats(vals);
    baselineByDate.set(curDate, { date: curDate, mean, sd, n });
  }

  return recs.map((r) => baselineByDate.get(r.date));
}

// -----------------------------------------------------------------------
// deviation
// -----------------------------------------------------------------------
export function deviation(records, field, { days = 28 } = {}) {
  const recs = withDate(records);
  // `records` is documented as newest-first; take the first non-null value.
  const target = recs.find((r) => isNum(r[field]));
  if (!target) {
    return { value: null, mean: null, sd: null, z: null, pctDelta: null };
  }

  const baselines = rollingBaseline(recs, field, { days });
  const idx = recs.indexOf(target);
  const baseline = baselines[idx] || { mean: null, sd: null, n: 0 };

  const value = target[field];
  const { mean, sd } = baseline;
  // Guard against floating-point noise: a "constant" baseline can compute
  // as e.g. sd=1.4e-13 instead of exactly 0, which would otherwise blow z
  // up to an astronomical (but technically non-NaN) number. Treat sd as
  // zero-spread below a relative epsilon.
  const sdEpsilon = isNum(mean) ? Math.max(1e-9, Math.abs(mean) * 1e-9) : 1e-9;
  const z = isNum(mean) && isNum(sd) && sd > sdEpsilon ? (value - mean) / sd : null;
  const pctDelta = isNum(mean) && mean !== 0 ? ((value - mean) / Math.abs(mean)) * 100 : null;

  return {
    value: round(value, 3),
    mean: round(mean, 3),
    sd: round(sd, 3),
    z: round(z, 2),
    pctDelta: round(pctDelta, 1),
  };
}

// -----------------------------------------------------------------------
// strainTargetFor
// -----------------------------------------------------------------------
// HEURISTIC, not WHOOP's actual algorithm: loosely modeled on WHOOP's
// "optimal strain" coaching copy, which nudges you toward higher strain
// on well-recovered days and lower strain on poorly-recovered days.
// center scales linearly with recovery% against the 0-21 strain scale,
// discounted by 0.85 so even a 100% recovery day doesn't suggest maxing
// out; the target band is +/-1.5 strain around that center, clamped to
// WHOOP's [0, 21] strain range.
export function strainTargetFor(recoveryScore) {
  if (!isNum(recoveryScore)) {
    return { low: null, high: null, center: null, label: null };
  }
  const clampedScore = clamp(recoveryScore, 0, 100);
  const center = clamp((clampedScore / 100) * 21 * 0.85, 0, 21);
  const low = clamp(center - 1.5, 0, 21);
  const high = clamp(center + 1.5, 0, 21);
  const label = center < 8 ? 'Take it easy' : center <= 14 ? 'Maintain' : 'Push';
  return { low: round(low, 1), high: round(high, 1), center: round(center, 1), label };
}

// -----------------------------------------------------------------------
// acwr — acute:chronic workload ratio
// -----------------------------------------------------------------------
export function acwr(cycles) {
  const recs = withDate(cycles);
  if (!recs.length) return { insufficient: true };

  const ascending = [...recs].sort(byDateAsc);
  const latestDate = ascending[ascending.length - 1].date;
  const acuteStart = addDays(latestDate, -6); // 7-day window, inclusive
  const chronicStart = addDays(latestDate, -27); // 28-day window, inclusive

  const acuteVals = ascending
    .filter((c) => c.date >= acuteStart && c.date <= latestDate)
    .map((c) => c.strain);
  const chronicVals = ascending
    .filter((c) => c.date >= chronicStart && c.date <= latestDate)
    .map((c) => c.strain);

  const chronicUsable = chronicVals.filter(isNum);
  if (chronicUsable.length < 14) return { insufficient: true };

  const acute7 = avg(acuteVals);
  const chronic28 = avg(chronicVals);
  const ratio = isNum(acute7) && isNum(chronic28) && chronic28 > 0 ? acute7 / chronic28 : null;
  const zone = isNum(ratio) ? (ratio < 0.8 ? 'undertraining' : ratio <= 1.3 ? 'optimal' : 'overreaching') : null;

  return {
    acute7: round(acute7, 2),
    chronic28: round(chronic28, 2),
    ratio: round(ratio, 2),
    zone,
  };
}

// -----------------------------------------------------------------------
// sleepDebtSeries
// -----------------------------------------------------------------------
export function sleepDebtSeries(sleep) {
  const recs = withDate(sleep);
  const ascending = [...recs].sort(byDateAsc);

  const cumByDate = new Map();
  for (let i = 0; i < ascending.length; i++) {
    const curDate = ascending[i].date;
    const windowStart = addDays(curDate, -6); // trailing 7-day window, inclusive of curDate
    let sum = 0;
    let any = false;
    for (let j = i; j >= 0; j--) {
      const rec = ascending[j];
      if (rec.date < windowStart) break;
      if (isNum(rec.debtMin)) {
        sum += rec.debtMin;
        any = true;
      }
    }
    cumByDate.set(curDate, any ? round(sum, 1) : null);
  }

  return recs.map((s) => ({
    date: s.date,
    debtMin: isNum(s.debtMin) ? s.debtMin : null,
    cumulative7dMin: cumByDate.get(s.date),
  }));
}

// -----------------------------------------------------------------------
// anomaly
// -----------------------------------------------------------------------
function pctSentence(label, dev, days, direction) {
  const pct = isNum(dev.pctDelta) ? Math.round(Math.abs(dev.pctDelta)) : null;
  return pct != null
    ? `${label} ${pct}% ${direction} your ${days}-day baseline.`
    : `${label} ${direction} your ${days}-day baseline.`;
}

export function anomaly({ recovery = [], sleep = [] } = {}, { days = 28 } = {}) {
  const reasons = [];
  let score = 0;

  const rhrDev = deviation(recovery, 'rhr', { days });
  const hrvDev = deviation(recovery, 'hrv', { days });
  const respDev = deviation(sleep, 'respiratoryRateBpm', { days });
  const skinDev = deviation(recovery, 'skinTempC', { days });

  // deviation() falls back to the newest *non-null* record, so we can't use
  // rhrDev.value to tell whether today specifically has no RHR reading —
  // check the true newest recovery record's own field for that.
  const newestRecovery = withDate(recovery)[0];
  const rhrMissingToday = !newestRecovery || newestRecovery.rhr == null;

  if (!rhrMissingToday && isNum(rhrDev.z) && rhrDev.z >= 1.5) {
    score += 1;
    reasons.push(pctSentence('RHR', rhrDev, days, 'above'));
  } else if (rhrMissingToday && isNum(hrvDev.z) && hrvDev.z <= -1.5) {
    // No RHR reading available for the newest record; a large HRV drop
    // stands in for it.
    score += 1;
    reasons.push(pctSentence('HRV', hrvDev, days, 'below') + ' (RHR unavailable.)');
  }

  if (isNum(respDev.z) && respDev.z >= 1.5) {
    score += 1;
    reasons.push(pctSentence('Respiratory rate', respDev, days, 'above'));
  }

  if (isNum(skinDev.z) && skinDev.z >= 1.5) {
    score += 1;
    reasons.push(pctSentence('Skin temperature', skinDev, days, 'above'));
  }

  return { flagged: score >= 2, score, reasons };
}

// -----------------------------------------------------------------------
// correlate
// -----------------------------------------------------------------------

// -----------------------------------------------------------------------
// periodCompare
// -----------------------------------------------------------------------
function meanFieldInRange(records, field, start, end) {
  const vals = (records || [])
    .filter((r) => r && r.date && r.date >= start && r.date <= end && isNum(r[field]))
    .map((r) => r[field]);
  return vals.length ? avg(vals) : null;
}

function meanSleepHoursInRange(sleep, start, end) {
  const vals = (sleep || [])
    .filter((s) => s && s.date && s.date >= start && s.date <= end && isNum(s.durationMin))
    .map((s) => s.durationMin / 60);
  return vals.length ? avg(vals) : null;
}

function buildMetric(aVal, bVal) {
  const a = round(aVal, 2);
  const b = round(bVal, 2);
  const delta = isNum(a) && isNum(b) ? round(a - b, 2) : null;
  const pctDelta = isNum(delta) && isNum(b) && b !== 0 ? round((delta / Math.abs(b)) * 100, 1) : null;
  return { a, b, delta, pctDelta };
}

const EMPTY_METRIC = { a: null, b: null, delta: null, pctDelta: null };

export function periodCompare({ recovery = [], sleep = [], cycles = [] } = {}, { aDays = 7, bDays = 7 } = {}) {
  const allDates = [
    ...withDate(recovery).map((r) => r.date),
    ...withDate(sleep).map((s) => s.date),
    ...withDate(cycles).map((c) => c.date),
  ];

  if (!allDates.length) {
    return {
      recovery: { ...EMPTY_METRIC },
      hrv: { ...EMPTY_METRIC },
      rhr: { ...EMPTY_METRIC },
      sleepHours: { ...EMPTY_METRIC },
      strain: { ...EMPTY_METRIC },
    };
  }

  const latestDate = allDates.reduce((max, d) => (d > max ? d : max));
  const aStart = addDays(latestDate, -(aDays - 1));
  const bEnd = addDays(aStart, -1);
  const bStart = addDays(bEnd, -(bDays - 1));

  return {
    recovery: buildMetric(
      meanFieldInRange(recovery, 'score', aStart, latestDate),
      meanFieldInRange(recovery, 'score', bStart, bEnd)
    ),
    hrv: buildMetric(
      meanFieldInRange(recovery, 'hrv', aStart, latestDate),
      meanFieldInRange(recovery, 'hrv', bStart, bEnd)
    ),
    rhr: buildMetric(
      meanFieldInRange(recovery, 'rhr', aStart, latestDate),
      meanFieldInRange(recovery, 'rhr', bStart, bEnd)
    ),
    sleepHours: buildMetric(
      meanSleepHoursInRange(sleep, aStart, latestDate),
      meanSleepHoursInRange(sleep, bStart, bEnd)
    ),
    strain: buildMetric(
      meanFieldInRange(cycles, 'strain', aStart, latestDate),
      meanFieldInRange(cycles, 'strain', bStart, bEnd)
    ),
  };
}
