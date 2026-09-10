// Full-history local store for whoop-desk, built on top of whoop-client.mjs.
//
// Node >= 20 (native fetch), ESM, no npm dependencies.
//
// Keeps every recovery/sleep/cycle/workout record the account has ever
// produced in a local JSON store (default: src/history.json, override via
// initHistory({dataDir})), so the rest of the app can do trend/history
// analysis without re-fetching WHOOP's full history on every run.
//
// Exports:
//   - initHistory({ dataDir }) -> void (sets store path to <dataDir>/history.json)
//   - backfillAll({ onProgress } = {}) -> { collections: { recovery, sleep, cycles, workouts } }
//       Paginates all 4 collections from account genesis to "now" (captured
//       once, at first run per collection), merging into the store and
//       persisting progress after every page so an interrupted run resumes
//       instead of restarting. Already-complete collections are skipped
//       entirely (no network calls) - re-running after a full backfill is a
//       fast no-op.
//   - syncRecent({ days = 7 } = {}) -> { fetched: { recovery, sleep, cycle, workout } }
//       Fetches a recent window and merges it in, and refreshes profile.
//   - getHistory({ days = 0 } = {}) -> { profile, recovery, sleep, cycles, workouts }
//       Reads the LOCAL store only. days=0 (or omitted) returns everything;
//       arrays are newest-first, in the same shapes getDashboard() produces.
//   - getStatus() -> { backfillComplete, oldestDate, newestDate, counts, sizeBytes }
//
// CLI:
//   node src/history.mjs --backfill   Runs a real backfill with progress lines
//                                      (one line per page: "<collection>: <count>").
//   node src/history.mjs --status     Prints getStatus() as JSON.
//
// Privacy: progress/status output is counts and dates only - never record
// contents, tokens, or secrets.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getAuthedContext,
  fetchRecordsPage,
  fetchAllRecords,
  fetchProfile,
  fetchBodyMeasurement,
  normalizeRecovery,
  normalizeSleep,
  normalizeCycle,
  normalizeWorkout,
  buildSleepArray,
  dateDesc,
  localDate,
  delay,
} from './whoop-client.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

// WHOOP the consumer product predates any real account by a safe margin;
// used as the backfill window's start so "from the beginning of the
// account" doesn't require knowing the account's actual join date. An
// overly-early start is harmless - the API just returns nothing before the
// account existed.
const GENESIS_START = '2010-01-01T00:00:00.000Z';

const PAGE_LIMIT = 25;
const THROTTLE_MS = 250;

// Kinds as used by whoop-client's fetch functions (singular, matches its
// V1/V2 path tables) vs. the collection names used in this module's public
// shape (matches getDashboard()'s plural array names).
const KINDS = ['recovery', 'sleep', 'cycle', 'workout'];
const KIND_TO_COLLECTION = { recovery: 'recovery', sleep: 'sleep', cycle: 'cycles', workout: 'workouts' };

let STORE_PATH = path.join(MODULE_DIR, 'history.json');

export function initHistory({ dataDir } = {}) {
  if (!dataDir) throw new Error('initHistory requires { dataDir }');
  STORE_PATH = path.join(dataDir, 'history.json');
}

// -----------------------------------------------------------------------
// Store I/O
// -----------------------------------------------------------------------
function emptyStore() {
  return {
    version: 1,
    profile: { firstName: null, lastName: null, heightM: null, weightKg: null, maxHr: null },
    profileUpdatedAt: null,
    // Raw WHOOP records, keyed by a stable dedup key per record, one map
    // per kind. Kept raw (not pre-normalized) so normalization changes in
    // whoop-client.mjs apply retroactively to old history without a re-fetch.
    raw: { recovery: {}, sleep: {}, cycle: {}, workout: {} },
    // Per-kind backfill progress, so an interrupted backfill resumes.
    backfill: {},
    meta: { createdAt: new Date().toISOString(), lastBackfillAt: null, lastSyncAt: null },
  };
}

async function loadStore() {
  try {
    const raw = await fsp.readFile(STORE_PATH, 'utf8');
    const store = JSON.parse(raw);
    // Tolerate a store from a slightly older shape by filling in anything
    // missing rather than failing outright.
    const fresh = emptyStore();
    return {
      ...fresh,
      ...store,
      profile: { ...fresh.profile, ...(store.profile || {}) },
      raw: { ...fresh.raw, ...(store.raw || {}) },
      backfill: { ...(store.backfill || {}) },
      meta: { ...fresh.meta, ...(store.meta || {}) },
    };
  } catch (err) {
    if (err && err.code === 'ENOENT') return emptyStore();
    throw err;
  }
}

async function saveStoreAtomic(store) {
  const dir = path.dirname(STORE_PATH);
  await fsp.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.history.json.${process.pid}.${Date.now()}.tmp`);
  // Compact (no pretty-print indent): this file can grow to thousands of
  // records over years of history, and it's not meant to be hand-edited.
  await fsp.writeFile(tmpPath, JSON.stringify(store), 'utf8');
  await fsp.rename(tmpPath, STORE_PATH);
}

// -----------------------------------------------------------------------
// Dedup keys
// -----------------------------------------------------------------------
// Recovery records carry no `id` of their own (they're 1:1 with a cycle,
// referenced by cycle_id); every other kind has a stable `id`.
function rawKey(kind, rec) {
  if (kind === 'recovery') {
    if (rec.cycle_id != null) return `cid:${rec.cycle_id}`;
    return `dt:${localDate(rec.created_at || rec.updated_at)}|${rec.created_at || ''}`;
  }
  if (rec.id != null) return `id:${rec.id}`;
  return `dt:${localDate(rec.end || rec.start || rec.created_at)}|${rec.start || ''}`;
}

function mergeRecords(store, kind, records) {
  for (const rec of records) {
    const key = rawKey(kind, rec);
    store.raw[kind][key] = rec;
  }
}

// -----------------------------------------------------------------------
// Normalization on read (reuses whoop-client's normalizers so history and
// getDashboard() always agree on shape).
// -----------------------------------------------------------------------
function normalizedFromStore(store) {
  const recovery = Object.values(store.raw.recovery).map(normalizeRecovery).sort(dateDesc);
  const sleep = buildSleepArray(Object.values(store.raw.sleep));
  const cycles = Object.values(store.raw.cycle).map(normalizeCycle).sort(dateDesc);
  const workouts = Object.values(store.raw.workout).map(normalizeWorkout).sort(dateDesc);
  return { profile: store.profile, recovery, sleep, cycles, workouts };
}

function filterByDays(normalized, days) {
  if (!days || days <= 0) return normalized;
  const cutoff = localDate(new Date(Date.now() - days * 86400000));
  const keep = (arr) => arr.filter((r) => r.date != null && r.date >= cutoff);
  return {
    profile: normalized.profile,
    recovery: keep(normalized.recovery),
    sleep: keep(normalized.sleep),
    cycles: keep(normalized.cycles),
    workouts: keep(normalized.workouts),
  };
}

// -----------------------------------------------------------------------
// backfillAll
// -----------------------------------------------------------------------
export async function backfillAll({ onProgress } = {}) {
  const store = await loadStore();
  const ctx = await getAuthedContext();
  const nowIso = new Date().toISOString();
  const result = { collections: {} };

  for (const kind of KINDS) {
    const collection = KIND_TO_COLLECTION[kind];
    let cursor = store.backfill[kind];

    if (!cursor) {
      cursor = {
        complete: false,
        windowStart: GENESIS_START,
        windowEnd: nowIso,
        nextToken: null,
        useV1: false,
        pages: 0,
      };
      store.backfill[kind] = cursor;
    }

    if (cursor.complete) {
      result.collections[collection] = { fetched: Object.keys(store.raw[kind]).length, skipped: true };
      if (onProgress) {
        onProgress({ collection, fetched: Object.keys(store.raw[kind]).length, done: true });
      }
      continue;
    }

    let nextToken = cursor.nextToken;
    let useV1 = cursor.useV1;

    for (;;) {
      await delay(THROTTLE_MS);

      const page = await fetchRecordsPage(
        kind,
        { start: cursor.windowStart, end: cursor.windowEnd, limit: PAGE_LIMIT, nextToken, useV1 },
        ctx
      );

      if (page.notFound && !useV1) {
        // v2 endpoint doesn't exist for this account/kind; switch to v1 and
        // restart this kind's pagination from the top of the same window.
        useV1 = true;
        nextToken = null;
        cursor.useV1 = true;
        cursor.nextToken = null;
        await saveStoreAtomic(store);
        continue;
      }

      mergeRecords(store, kind, page.records);
      nextToken = page.nextToken;
      cursor.nextToken = nextToken;
      cursor.useV1 = useV1;
      cursor.pages += 1;
      cursor.complete = !nextToken;
      await saveStoreAtomic(store);

      const fetched = Object.keys(store.raw[kind]).length;
      if (onProgress) onProgress({ collection, fetched, done: !nextToken });

      if (!nextToken) break;
    }

    result.collections[collection] = { fetched: Object.keys(store.raw[kind]).length, skipped: false };
  }

  if (KINDS.every((k) => store.backfill[k]?.complete)) {
    store.meta.lastBackfillAt = new Date().toISOString();
    await saveStoreAtomic(store);
  }

  return result;
}

// -----------------------------------------------------------------------
// syncRecent
// -----------------------------------------------------------------------
export async function syncRecent({ days = 7 } = {}) {
  const store = await loadStore();
  const ctx = await getAuthedContext();
  const notes = { v1Fallbacks: [] };

  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const range = { start: start.toISOString(), end: end.toISOString() };

  const [recoveryRaw, sleepRaw, cycleRaw, workoutRaw, profileBasic, bodyMeasurement] = await Promise.all([
    fetchAllRecords('recovery', range, ctx, notes),
    fetchAllRecords('sleep', range, ctx, notes),
    fetchAllRecords('cycle', range, ctx, notes),
    fetchAllRecords('workout', range, ctx, notes),
    fetchProfile(ctx, notes),
    fetchBodyMeasurement(ctx, notes),
  ]);

  mergeRecords(store, 'recovery', recoveryRaw);
  mergeRecords(store, 'sleep', sleepRaw);
  mergeRecords(store, 'cycle', cycleRaw);
  mergeRecords(store, 'workout', workoutRaw);

  store.profile = { ...store.profile, ...profileBasic, ...bodyMeasurement };
  store.profileUpdatedAt = new Date().toISOString();
  store.meta.lastSyncAt = new Date().toISOString();

  await saveStoreAtomic(store);

  return {
    fetched: {
      recovery: recoveryRaw.length,
      sleep: sleepRaw.length,
      cycle: cycleRaw.length,
      workout: workoutRaw.length,
    },
  };
}

// -----------------------------------------------------------------------
// getHistory / getStatus (local store only, no network)
// -----------------------------------------------------------------------
export async function getHistory({ days = 0 } = {}) {
  const store = await loadStore();
  return filterByDays(normalizedFromStore(store), days);
}

export async function getStatus() {
  const store = await loadStore();
  const normalized = normalizedFromStore(store);

  const allDates = [
    ...normalized.recovery.map((r) => r.date),
    ...normalized.sleep.map((r) => r.date),
    ...normalized.cycles.map((r) => r.date),
    ...normalized.workouts.map((r) => r.date),
  ].filter(Boolean);

  const oldestDate = allDates.length ? allDates.reduce((a, b) => (a < b ? a : b)) : null;
  const newestDate = allDates.length ? allDates.reduce((a, b) => (a > b ? a : b)) : null;

  let sizeBytes = 0;
  try {
    sizeBytes = (await fsp.stat(STORE_PATH)).size;
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }

  const backfillComplete = KINDS.every((k) => store.backfill[k]?.complete === true);

  return {
    backfillComplete,
    oldestDate,
    newestDate,
    counts: {
      recovery: normalized.recovery.length,
      sleep: normalized.sleep.length,
      cycles: normalized.cycles.length,
      workouts: normalized.workouts.length,
    },
    sizeBytes,
  };
}

// -----------------------------------------------------------------------
// CLI: `node src/history.mjs --backfill` / `--status`
// -----------------------------------------------------------------------
async function runBackfillCli() {
  const started = Date.now();
  await backfillAll({
    onProgress({ collection, fetched, done }) {
      console.log(`${collection}: ${fetched}${done ? ' (done)' : ''}`);
    },
  });
  const status = await getStatus();
  const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`backfill finished in ${elapsedSec}s`);
  console.log(JSON.stringify(status, null, 2));
}

async function runStatusCli() {
  const status = await getStatus();
  console.log(JSON.stringify(status, null, 2));
}

const isMainModule = (() => {
  const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
  return invoked && fs.existsSync(invoked) && fs.realpathSync(invoked) === fileURLToPath(import.meta.url);
})();

if (isMainModule) {
  if (process.argv.includes('--backfill')) {
    runBackfillCli().catch((err) => {
      console.error('Backfill failed:', err && err.message ? err.message : err);
      process.exitCode = 1;
    });
  } else if (process.argv.includes('--status')) {
    runStatusCli().catch((err) => {
      console.error('Status failed:', err && err.message ? err.message : err);
      process.exitCode = 1;
    });
  }
}
