// Heart-rate monitor for whoop-desk.
//
// WHOOP's public developer API exposes NO heart-rate time series: no
// intraday, per-second or realtime samples. The finest-grained figures on
// the in-progress cycle are:
//
//   average_heart_rate  integer  (rounded to whole bpm)
//   max_heart_rate      integer
//   kilojoule           fractional, 3 decimals, monotonically increasing
//
// Differencing consecutive cumulative AVERAGES looks appealing but is
// unusable in practice: the average is an integer, so its +/-0.5 bpm
// quantisation is multiplied by elapsed-time/span. Measured on real data at
// 1292 minutes into a cycle, a 2-minute span carries +/-646 bpm of error.
// Sampling faster makes that strictly worse.
//
// Energy is the precise channel. kilojoule is fractional, so the energy
// burned between two readings is exact to three decimals at any span, and
// energy expenditure maps onto heart rate. That map is personal, so it is
// fitted from the user's OWN history: every workout and completed cycle
// supplies a (kJ/min, average bpm) pair. On this user's 1,317 pairs the fit
// is R^2 0.884 with 9.6 bpm RMSE, and a 4-fold hold-out gives 9.0 bpm
// median error. Heart rate is therefore reported as an ESTIMATE, with the
// model's own error published alongside it, never as a measurement.
//
// Measured values (day average, day max, per-workout average and max) are
// passed through untouched and labelled as measured.
//
// Node >= 20, ESM. Runs in the Electron MAIN process.
//
// Exports:
//   initHrMonitor({ dataDir })   -> store
//   store.record({ cycle })      -> { added, sample }
//   store.setModel(model)        -> install a fitted model
//   store.getSeries({...})       -> see buildSeries()
//   calibrationPoints({ workouts, cycles })
//   fitEnergyModel(points)
//   estimateBpm(kjPerMin, model)
//   deriveIntervals(samples, model)
//   RETENTION_DAYS

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const RETENTION_DAYS = 3;

// A derived value outside this band means the cumulative averages moved in a
// way a real heart cannot (usually a cycle rollover or a corrected reading).
const MIN_PLAUSIBLE_BPM = 25;
const MAX_PLAUSIBLE_BPM = 240;

// Two readings closer together than this carry too little new signal for the
// difference of cumulative averages to be numerically meaningful.
const MIN_SPAN_MIN = 0.75;

function localDateOf(iso, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(iso));
    const get = (t) => parts.find((p) => p.type === t)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return String(iso).slice(0, 10);
  }
}


// -----------------------------------------------------------------------
// Pure helpers shared with the renderer (renderer keeps tiny copies since
// it cannot import ESM; these exported versions are the tested truth).
// -----------------------------------------------------------------------

// RMSSD over a window of RR intervals in milliseconds. Needs at least 4
// plausible beats; artifacts outside 250-2500 ms are dropped pairwise.
export function rmssd(rrMs) {
  const diffs = [];
  for (let i = 1; i < (rrMs || []).length; i++) {
    const a = rrMs[i - 1];
    const b = rrMs[i];
    if (a > 250 && a < 2500 && b > 250 && b < 2500) diffs.push(b - a);
  }
  if (diffs.length < 3) return null;
  const meanSq = diffs.reduce((s, d) => s + d * d, 0) / diffs.length;
  return Math.round(Math.sqrt(meanSq));
}

// Inverse of the personal energy model: bpm -> kJ/min. Used to turn a live
// measured heart rate into a calorie burn rate.
export function invertEnergyModel(bpm, model) {
  if (!model || !Number.isFinite(bpm) || !Number.isFinite(model.intercept) || !model.slope) return null;
  const x = (bpm - model.intercept) / model.slope;
  if (!(x > 0)) return 0;
  return x * x;
}

// Rough WHOOP-style strain from time in HR zones. Zone minutes are weighted
// exponentially (harder zones count much more) and squashed onto the 0-21
// scale. This is an approximation and is always labelled as such.
export function approxStrain(zoneSeconds) {
  const w = { z1: 1, z2: 2, z3: 4, z4: 8, z5: 16 };
  let raw = 0;
  for (const k of Object.keys(w)) raw += ((zoneSeconds && zoneSeconds[k]) || 0) / 60 * w[k];
  return Number((21 * (1 - Math.exp(-raw / 200))).toFixed(1));
}

// Average measured beats into fixed buckets so a 1 Hz stream can sit on the
// day chart without swamping it.
export function bucketMeasured(measured, bucketSec = 120) {
  const buckets = new Map();
  for (const m of measured || []) {
    const ms = new Date(m.t).getTime();
    if (!Number.isFinite(ms) || !Number.isFinite(m.bpm)) continue;
    const key = Math.floor(ms / (bucketSec * 1000));
    const b = buckets.get(key) || { sum: 0, n: 0, key };
    b.sum += m.bpm;
    b.n += 1;
    buckets.set(key, b);
  }
  return [...buckets.values()]
    .sort((a, b) => a.key - b.key)
    .map((b) => ({
      t: new Date((b.key + 1) * bucketSec * 1000).toISOString(),
      bpm: Math.round(b.sum / b.n),
      source: 'measured',
    }));
}

// Day chart series: measured buckets are ground truth; estimated intervals
// fill only the stretches no strap session covered.
export function mergeDayPoints(estimated, measuredBuckets) {
  const pts = (measuredBuckets || []).map((m) => ({ t: m.t, bpm: m.bpm, source: 'measured' }));
  for (const e of estimated || []) {
    const eMs = new Date(e.t).getTime();
    const windowMs = Math.max(2, e.spanMin || 2) * 60000;
    const covered = (measuredBuckets || []).some(
      (m) => Math.abs(new Date(m.t).getTime() - eMs) < windowMs
    );
    if (!covered) pts.push({ t: e.t, bpm: e.bpm, source: 'estimated' });
  }
  pts.sort((a, b) => new Date(a.t) - new Date(b.t));
  return pts;
}

// -----------------------------------------------------------------------
// Personal energy -> heart-rate model
// -----------------------------------------------------------------------
// Heart rate rises with energy burn but flattens out, so the fit is done
// against sqrt(kJ/min), which linearises it better than the raw rate
// (R^2 0.884 vs 0.874 on this user's history).
const MIN_CALIBRATION_POINTS = 12;

export function calibrationPoints({ workouts = [], cycles = [] } = {}) {
  const pts = [];
  const add = (kj, min, bpm, kind) => {
    if (!Number.isFinite(kj) || !Number.isFinite(min) || !Number.isFinite(bpm)) return;
    if (kj <= 0 || min <= 0 || bpm <= 0) return;
    pts.push({ kjPerMin: kj / min, bpm, kind });
  };
  // Workouts are short and span the high end of the range.
  for (const w of workouts) add(w.kilojoules, w.durationMin, w.avgHr, 'workout');
  // Completed cycles anchor the resting end. An in-progress cycle has no
  // end and is skipped, since its duration is not yet known.
  for (const c of cycles) {
    if (!c.end || !c.start) continue;
    const min = (new Date(c.end) - new Date(c.start)) / 60000;
    if (min < 60) continue;
    add(c.kilojoules, min, c.avgHr, 'cycle');
  }
  return pts;
}

export function fitEnergyModel(points) {
  const pts = (points || []).filter((p) => p && p.kjPerMin > 0 && p.bpm > 0);
  if (pts.length < MIN_CALIBRATION_POINTS) return null;

  const x = pts.map((p) => Math.sqrt(p.kjPerMin));
  const y = pts.map((p) => p.bpm);
  const n = pts.length;
  const sx = x.reduce((a, b) => a + b, 0);
  const sy = y.reduce((a, b) => a + b, 0);
  const sxx = x.reduce((a, b) => a + b * b, 0);
  const sxy = x.reduce((a, b, i) => a + b * y[i], 0);
  const denom = n * sxx - sx * sx;
  if (!denom) return null;

  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const predict = (xi) => intercept + slope * xi;
  const ssRes = x.reduce((a, xi, i) => a + (y[i] - predict(xi)) ** 2, 0);
  const mean = sy / n;
  const ssTot = y.reduce((a, yi) => a + (yi - mean) ** 2, 0);

  return {
    intercept,
    slope,
    n,
    r2: ssTot ? Number((1 - ssRes / ssTot).toFixed(3)) : null,
    rmse: Number(Math.sqrt(ssRes / n).toFixed(1)),
    fittedAt: new Date().toISOString(),
  };
}

export function estimateBpm(kjPerMin, model) {
  if (!model || !Number.isFinite(kjPerMin) || kjPerMin < 0) return null;
  const bpm = model.intercept + model.slope * Math.sqrt(kjPerMin);
  if (!Number.isFinite(bpm) || bpm < MIN_PLAUSIBLE_BPM || bpm > MAX_PLAUSIBLE_BPM) return null;
  return Math.round(bpm);
}

// -----------------------------------------------------------------------
// Interval derivation from energy (pure, exported for tests)
// -----------------------------------------------------------------------
export function deriveIntervals(samples, model) {
  const out = [];
  const sorted = (samples || [])
    .filter((s) => s && Number.isFinite(s.kilojoules) && Number.isFinite(s.elapsedMin))
    .slice()
    .sort((a, b) => new Date(a.t) - new Date(b.t));

  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    // A new cycle resets both elapsed time and cumulative energy.
    if (b.cycleId != null && a.cycleId != null && b.cycleId !== a.cycleId) continue;

    const spanMin = b.elapsedMin - a.elapsedMin;
    if (spanMin < MIN_SPAN_MIN) continue;

    const deltaKj = b.kilojoules - a.kilojoules;
    // Energy only accumulates; a decrease means a corrected or reset record.
    if (!(deltaKj >= 0)) continue;

    const kjPerMin = deltaKj / spanMin;
    const bpm = estimateBpm(kjPerMin, model);
    if (bpm == null) continue;

    out.push({
      t: b.t,
      from: a.t,
      bpm,
      kjPerMin: Number(kjPerMin.toFixed(2)),
      spanMin: Number(spanMin.toFixed(1)),
      estimated: true,
    });
  }
  return out;
}

// WHOOP-measured workout averages. Used as context markers and to cover
// stretches of the day that happened before sampling began. Marked
// estimated:false — these come from WHOOP, not from the model.
export function workoutPoints(workouts, date) {
  return (workouts || [])
    .filter((w) => w && w.date === date && Number.isFinite(w.avgHr) && w.start)
    .map((w) => ({
      t: w.start,
      bpm: Math.round(w.avgHr),
      maxBpm: Number.isFinite(w.maxHr) ? Math.round(w.maxHr) : null,
      spanMin: Number.isFinite(w.durationMin) ? w.durationMin : null,
      sport: w.sport || 'Activity',
      estimated: false,
    }));
}

export function buildSeries({ samples, measured, sessions, strapInfo, cycle, workouts, date, timeZone, model }) {
  const tz = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = date || localDateOf(new Date().toISOString(), tz);
  const todays = (samples || []).filter((s) => localDateOf(s.t, tz) === today);

  const intervals = deriveIntervals(todays, model);
  const activities = workoutPoints(workouts, today);

  const newest = todays.length ? todays[todays.length - 1] : null;
  const latest = intervals.length ? intervals[intervals.length - 1] : null;
  const bpms = intervals.map((i) => i.bpm);

  // Measured (strap broadcast) readings for the same local day, plus the
  // last 20 minutes at full resolution so a reopened window can restore its
  // live strip.
  const measuredToday = (measured || []).filter((m) => localDateOf(m.t, tz) === today);
  const recentCutoff = Date.now() - 20 * 60000;
  const measuredRecent = measuredToday.filter((m) => new Date(m.t).getTime() >= recentCutoff);
  const mLatest = measuredToday.length ? measuredToday[measuredToday.length - 1] : null;
  const mBpms = measuredToday.map((m) => m.bpm);

  return {
    // Estimated bpm per polling interval, from energy burned.
    points: intervals,
    // WHOOP-measured per-activity averages.
    activities,
    // Measured, straight off the cycle.
    cycleAvgHr: cycle && Number.isFinite(cycle.avgHr) ? Math.round(cycle.avgHr) : null,
    cycleMaxHr: cycle && Number.isFinite(cycle.maxHr) ? Math.round(cycle.maxHr) : null,
    latestBpm: latest ? latest.bpm : null,
    latestAt: latest ? latest.t : null,
    latestKjPerMin: latest ? latest.kjPerMin : null,
    rangeBpm: bpms.length ? { lo: Math.min(...bpms), hi: Math.max(...bpms) } : null,
    sampleCount: todays.length,
    lastSampleAt: newest ? newest.t : null,
    date: today,
    dayPoints: mergeDayPoints(intervals, bucketMeasured(measuredToday)),
    lastSession: sessions && sessions.length ? sessions[sessions.length - 1] : null,
    sessionCount: (sessions || []).length,
    strapInfo: strapInfo || null,
    measured: {
      count: measuredToday.length,
      latestBpm: mLatest ? mLatest.bpm : null,
      latestAt: mLatest ? mLatest.t : null,
      rangeBpm: mBpms.length ? { lo: Math.min(...mBpms), hi: Math.max(...mBpms) } : null,
      recent: measuredRecent,
    },
    // Published so the UI can state the estimate's accuracy rather than
    // implying the line is measured.
    model: model
      ? {
          n: model.n, r2: model.r2, rmse: model.rmse, fittedAt: model.fittedAt,
          // Coefficients are published so the renderer can invert the model
          // for live calorie burn during a workout.
          intercept: model.intercept, slope: model.slope,
        }
      : null,
    warmingUp: intervals.length < 1,
  };
}

// -----------------------------------------------------------------------
// Persisted store
// -----------------------------------------------------------------------
export async function initHrMonitor({ dataDir } = {}) {
  if (!dataDir) throw new Error('initHrMonitor requires a dataDir');
  const filePath = path.join(dataDir, 'hr-samples.json');
  let samples = [];
  let measured = []; // BLE strap broadcast: [{ t, bpm }], truly measured
  let sessions = []; // completed live-workout sessions, newest last
  let strapInfo = null; // probe results: battery, firmware, rrSupported, ...
  let model = null;
  let queue = Promise.resolve();

  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.samples)) samples = parsed.samples;
    if (Array.isArray(parsed?.measured)) measured = parsed.measured;
    if (Array.isArray(parsed?.sessions)) sessions = parsed.sessions;
    if (parsed?.strapInfo) strapInfo = parsed.strapInfo;
    if (parsed?.model) model = parsed.model;
  } catch (err) {
    if (err && err.code !== 'ENOENT') console.error('hr-monitor: could not read store:', err);
  }

  function prune() {
    const cutoff = Date.now() - RETENTION_DAYS * 86400000;
    samples = samples.filter((s) => new Date(s.t).getTime() >= cutoff);
    measured = measured.filter((s) => new Date(s.t).getTime() >= cutoff);
  }

  async function persist() {
    await fsp.mkdir(dataDir, { recursive: true });
    const tmp = path.join(dataDir, `.hr-samples.json.${process.pid}.${Date.now()}.tmp`);
    await fsp.writeFile(tmp, JSON.stringify({ samples, measured, sessions, strapInfo, model }, null, 2), 'utf8');
    await fsp.rename(tmp, filePath);
  }

  function enqueue(fn) {
    queue = queue.then(fn, fn);
    return queue;
  }

  return {
    filePath,

    // Records one reading of the in-progress cycle. Returns { added } so the
    // caller can skip pushing an unchanged series to the renderer.
    record({ cycle, at = new Date().toISOString() } = {}) {
      return enqueue(async () => {
        // kilojoule is the channel that actually carries resolution.
        if (!cycle || !Number.isFinite(cycle.kilojoules) || !cycle.start) return { added: false };
        const elapsedMin = (new Date(at) - new Date(cycle.start)) / 60000;
        if (!Number.isFinite(elapsedMin) || elapsedMin <= 0) return { added: false };

        const last = samples[samples.length - 1];
        // WHOOP publishes new data in batches, so most polls see an
        // unchanged record. Storing those adds zero-energy spans that would
        // read as a resting heart rate the user never had.
        if (last && last.cycleId === (cycle.id ?? null) && last.kilojoules === cycle.kilojoules) {
          return { added: false };
        }

        const sample = {
          t: at,
          cycleId: cycle.id ?? null,
          cycleStart: cycle.start,
          elapsedMin: Number(elapsedMin.toFixed(2)),
          kilojoules: cycle.kilojoules,
          avgHr: Number.isFinite(cycle.avgHr) ? cycle.avgHr : null,
          maxHr: cycle.maxHr ?? null,
        };
        samples.push(sample);
        prune();
        await persist();
        return { added: true, sample };
      });
    },

    getSeries({ cycle, workouts, date, timeZone } = {}) {
      return buildSeries({
        samples: samples.slice(),
        measured: measured.slice(),
        sessions: sessions.slice(),
        strapInfo,
        cycle, workouts, date, timeZone, model,
      });
    },

    addSession(session) {
      return enqueue(async () => {
        if (!session || !session.startedAt) return { added: false };
        sessions.push(session);
        if (sessions.length > 50) sessions = sessions.slice(-50);
        await persist();
        return { added: true, count: sessions.length };
      });
    },

    setStrapInfo(info) {
      return enqueue(async () => {
        if (!info || typeof info !== 'object') return { ok: false };
        strapInfo = { ...(strapInfo || {}), ...info, updatedAt: new Date().toISOString() };
        await persist();
        return { ok: true, strapInfo };
      });
    },

    listMeasured() {
      return measured.slice();
    },

    listSessions() {
      return sessions.slice();
    },

    // Batch of truly measured readings from the strap's Bluetooth heart-rate
    // broadcast. Deduped on timestamp, clamped to plausible bpm, appended in
    // time order.
    recordMeasuredBatch(batch) {
      return enqueue(async () => {
        const clean = (batch || [])
          .filter((x) => x && x.t && Number.isFinite(x.bpm)
            && x.bpm >= MIN_PLAUSIBLE_BPM && x.bpm <= MAX_PLAUSIBLE_BPM
            && !Number.isNaN(new Date(x.t).getTime()))
          .map((x) => ({ t: x.t, bpm: Math.round(x.bpm) }));
        if (!clean.length) return { added: 0 };
        const lastT = measured.length ? new Date(measured[measured.length - 1].t).getTime() : -Infinity;
        const fresh = clean
          .filter((x) => new Date(x.t).getTime() > lastT)
          .sort((a, b) => new Date(a.t) - new Date(b.t));
        if (!fresh.length) return { added: 0 };
        measured.push(...fresh);
        prune();
        await persist();
        return { added: fresh.length };
      });
    },

    // Installs a freshly fitted model and persists it, so a restart keeps
    // estimating before the first refit completes.
    setModel(next) {
      if (!next) return null;
      model = next;
      enqueue(persist).catch((err) => console.error('hr-monitor: model persist failed:', err));
      return model;
    },

    getModel() {
      return model;
    },

    // Test/debug helper: the raw readings.
    listSamples() {
      return samples.slice();
    },
  };
}

export default {
  initHrMonitor, deriveIntervals, workoutPoints, buildSeries,
  calibrationPoints, fitEnergyModel, estimateBpm,
  rmssd, invertEnergyModel, approxStrain, bucketMeasured, mergeDayPoints,
  RETENTION_DAYS,
};
