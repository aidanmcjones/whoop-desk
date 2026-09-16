// Heart-rate monitor for whoop-desk.
//
// WHOOP's public developer API exposes NO heart-rate time series: no
// intraday, per-second or realtime samples. The finest-grained heart rate
// available is the running average/max on the in-progress cycle, plus
// per-workout average/max and time-in-zone totals.
//
// So this module builds a heart-rate series the only way the API allows:
// it polls the current cycle on a short interval and records each reading.
// Because the cycle's average_heart_rate is a time-weighted mean over the
// whole cycle so far, the heart rate DURING the gap between two readings
// can be recovered from consecutive cumulative averages:
//
//   bpm(a -> b) = (avg_b * elapsed_b - avg_a * elapsed_a) / (elapsed_b - elapsed_a)
//
// That yields an actual bpm-over-time line at the polling resolution, which
// is as close to live heart rate as this API permits. Samples are persisted
// so the series survives restarts, and today's workouts are used to seed
// periods that happened before sampling began.
//
// Node >= 20, ESM. Runs in the Electron MAIN process.
//
// Exports:
//   initHrMonitor({ dataDir })  -> store
//   store.record({ cycle })     -> { added, sample }
//   store.getSeries({ cycle, workouts, date }) -> see buildSeries()
//   deriveIntervals(samples)    -> [{ t, bpm, spanMin }]
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
// Interval derivation (pure, exported for tests)
// -----------------------------------------------------------------------
export function deriveIntervals(samples) {
  const out = [];
  const sorted = (samples || [])
    .filter((s) => s && Number.isFinite(s.avgHr) && Number.isFinite(s.elapsedMin) && s.elapsedMin > 0)
    .slice()
    .sort((a, b) => new Date(a.t) - new Date(b.t));

  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    // A new cycle resets elapsed time; the pair is not comparable.
    if (b.cycleId != null && a.cycleId != null && b.cycleId !== a.cycleId) continue;
    const spanMin = b.elapsedMin - a.elapsedMin;
    if (spanMin < MIN_SPAN_MIN) continue;

    const bpm = (b.avgHr * b.elapsedMin - a.avgHr * a.elapsedMin) / spanMin;
    if (!Number.isFinite(bpm) || bpm < MIN_PLAUSIBLE_BPM || bpm > MAX_PLAUSIBLE_BPM) continue;

    out.push({
      t: b.t,
      from: a.t,
      bpm: Math.round(bpm),
      spanMin: Number(spanMin.toFixed(1)),
      derived: true,
    });
  }
  return out;
}

// Workout average heart rate, used to fill stretches of the day that
// happened before sampling started. Marked derived:false — these are
// reported by WHOOP rather than computed here.
export function workoutPoints(workouts, date) {
  return (workouts || [])
    .filter((w) => w && w.date === date && Number.isFinite(w.avgHr) && w.start)
    .map((w) => ({
      t: w.start,
      bpm: Math.round(w.avgHr),
      maxBpm: Number.isFinite(w.maxHr) ? Math.round(w.maxHr) : null,
      spanMin: Number.isFinite(w.durationMin) ? w.durationMin : null,
      sport: w.sport || 'Activity',
      derived: false,
    }));
}

export function buildSeries({ samples, cycle, workouts, date, timeZone }) {
  const tz = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = date || localDateOf(new Date().toISOString(), tz);
  const todays = (samples || []).filter((s) => localDateOf(s.t, tz) === today);

  const intervals = deriveIntervals(todays);
  const activities = workoutPoints(workouts, today);

  const newest = todays.length ? todays[todays.length - 1] : null;
  const latestInterval = intervals.length ? intervals[intervals.length - 1] : null;

  const bpms = intervals.map((i) => i.bpm);
  return {
    // The series the chart draws: bpm during each polling gap.
    points: intervals,
    // WHOOP-reported per-activity averages, for context markers.
    activities,
    // Cumulative figures straight from the cycle, always available.
    cycleAvgHr: cycle && Number.isFinite(cycle.avgHr) ? Math.round(cycle.avgHr) : null,
    cycleMaxHr: cycle && Number.isFinite(cycle.maxHr) ? Math.round(cycle.maxHr) : null,
    latestBpm: latestInterval ? latestInterval.bpm : null,
    latestAt: latestInterval ? latestInterval.t : null,
    rangeBpm: bpms.length ? { lo: Math.min(...bpms), hi: Math.max(...bpms) } : null,
    sampleCount: todays.length,
    lastSampleAt: newest ? newest.t : null,
    date: today,
    // True once at least two readings exist, i.e. the line has a segment.
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
  let queue = Promise.resolve();

  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.samples)) samples = parsed.samples;
  } catch (err) {
    if (err && err.code !== 'ENOENT') console.error('hr-monitor: could not read store:', err);
  }

  function prune() {
    const cutoff = Date.now() - RETENTION_DAYS * 86400000;
    samples = samples.filter((s) => new Date(s.t).getTime() >= cutoff);
  }

  async function persist() {
    await fsp.mkdir(dataDir, { recursive: true });
    const tmp = path.join(dataDir, `.hr-samples.json.${process.pid}.${Date.now()}.tmp`);
    await fsp.writeFile(tmp, JSON.stringify({ samples }, null, 2), 'utf8');
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
        if (!cycle || !Number.isFinite(cycle.avgHr) || !cycle.start) return { added: false };
        const elapsedMin = (new Date(at) - new Date(cycle.start)) / 60000;
        if (!Number.isFinite(elapsedMin) || elapsedMin <= 0) return { added: false };

        const last = samples[samples.length - 1];
        // Nothing new: same cycle, same rounded average, same max.
        if (
          last &&
          last.cycleId === (cycle.id ?? null) &&
          last.avgHr === cycle.avgHr &&
          last.maxHr === (cycle.maxHr ?? null) &&
          elapsedMin - last.elapsedMin < MIN_SPAN_MIN
        ) {
          return { added: false };
        }

        const sample = {
          t: at,
          cycleId: cycle.id ?? null,
          cycleStart: cycle.start,
          elapsedMin: Number(elapsedMin.toFixed(2)),
          avgHr: cycle.avgHr,
          maxHr: cycle.maxHr ?? null,
        };
        samples.push(sample);
        prune();
        await persist();
        return { added: true, sample };
      });
    },

    getSeries({ cycle, workouts, date, timeZone } = {}) {
      return buildSeries({ samples: samples.slice(), cycle, workouts, date, timeZone });
    },

    // Test/debug helper: the raw readings.
    listSamples() {
      return samples.slice();
    },
  };
}

export default { initHrMonitor, deriveIntervals, workoutPoints, buildSeries, RETENTION_DAYS };
