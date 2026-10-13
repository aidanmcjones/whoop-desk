// WHOOP API data layer for whoop-desk.
//
// Node >= 20 (native fetch), ESM, no npm dependencies.
//
// Auth:
//   - OAuth tokens cached at ~/.whoop-mcp/tokens.json (mode 0600):
//       { access_token, refresh_token, expires_at (ms epoch), token_type }
//   - Client credentials for refresh live in ~/.claude.json under
//       mcpServers.whoop.env.{WHOOP_CLIENT_ID,WHOOP_CLIENT_SECRET}
//
// Exports:
//   - getDashboard({ days = 30 } = {}) -> normalized dashboard payload
//   - getCached() -> parsed last-dashboard.json, or null if absent
//
//   Building blocks reused by src/history.mjs for full-history backfill
//   (see that file for the higher-level store API):
//   - getValidTokens() / getAuthedContext() -> { tokens, _refreshing }
//   - apiFetch(url, ctx) -> Response (handles 401 refresh + 429 retry)
//   - fetchRecordsPage(kind, { start, end, limit, nextToken, useV1 }, ctx)
//       -> { notFound, records, nextToken } (kind: recovery|sleep|cycle|workout)
//   - fetchAllRecords(kind, { start, end, limit }, ctx, notes) -> records[]
//   - fetchProfile(ctx, notes) -> { firstName, lastName }
//   - fetchBodyMeasurement(ctx, notes) -> { heightM, weightKg, maxHr }
//   - normalizeRecovery/normalizeSleep/normalizeCycle/normalizeWorkout(r)
//   - buildSleepArray(rawSleepRecords) -> sleep[] (handles nap folding)
//   - dateDesc(a, b), localDate(isoOrDate), milliToMin(ms), delay(ms)
//
// CLI test mode: `node src/whoop-client.mjs --test`

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKENS_PATH = path.join(os.homedir(), '.whoop-mcp', 'tokens.json');
const CLAUDE_CONFIG_PATH = path.join(os.homedir(), '.claude.json');

const API_BASE = 'https://api.prod.whoop.com/developer';
const TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';

// A socket left half-open by sleep or a Wi-Fi change never errors on its
// own, and one hung request would stall every later sync behind it.
const REQUEST_TIMEOUT_MS = 20000;

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(MODULE_DIR, 'last-dashboard.json');

const TIMEZONE = 'America/Chicago';

const V2_PATHS = {
  recovery: '/v2/recovery',
  sleep: '/v2/activity/sleep',
  cycle: '/v2/cycle',
  workout: '/v2/activity/workout',
};
const V1_PATHS = {
  recovery: '/v1/recovery',
  sleep: '/v1/activity/sleep',
  cycle: '/v1/cycle',
  workout: '/v1/activity/workout',
};

// -----------------------------------------------------------------------
// Sport id -> human name (WHOOP v2 usually supplies sport_name directly;
// this is the fallback for records that only carry sport_id, e.g. some
// v1 responses).
// -----------------------------------------------------------------------
const SPORT_NAMES = {
  0: 'Running',
  1: 'Cycling',
  16: 'Baseball',
  17: 'Basketball',
  18: 'Rowing',
  19: 'Fencing',
  20: 'Field Hockey',
  21: 'Football',
  22: 'Golf',
  24: 'Ice Hockey',
  25: 'Lacrosse',
  27: 'Rugby',
  28: 'Sailing',
  29: 'Skiing',
  30: 'Soccer',
  31: 'Softball',
  32: 'Squash',
  33: 'Swimming',
  34: 'Tennis',
  35: 'Track & Field',
  36: 'Volleyball',
  37: 'Water Polo',
  38: 'Wrestling',
  39: 'Boxing',
  42: 'Dance',
  43: 'Pilates',
  44: 'Yoga',
  45: 'Weightlifting',
  47: 'Cross Country Skiing',
  48: 'Functional Fitness',
  49: 'Duathlon',
  51: 'Gymnastics',
  52: 'Hiking/Rucking',
  53: 'Horseback Riding',
  55: 'Kayaking',
  56: 'Martial Arts',
  57: 'Mountain Biking',
  59: 'Powerlifting',
  60: 'Rock Climbing',
  61: 'Paddleboarding',
  62: 'Triathlon',
  63: 'Walking',
  64: 'Surfing',
  65: 'Elliptical',
  66: 'Stairmaster',
  70: 'Meditation',
  71: 'Other',
  73: 'Diving',
  82: 'Ultimate',
  84: 'Jumping Rope',
  85: 'Australian Football',
  86: 'Skateboarding',
  88: 'Ice Bath',
  90: 'Gaming',
  91: 'Snowboarding',
  92: 'Motocross',
  94: 'Obstacle Course Racing',
  95: 'Motor Racing',
  96: 'HIIT',
  97: 'Spin',
  98: 'Jiu Jitsu',
  100: 'Cricket',
  101: 'Pickleball',
  102: 'Inline Skating',
  103: 'Box Fitness',
  106: 'Paddle Tennis',
  107: 'Barre',
  125: 'Assault Bike',
  126: 'Kickboxing',
  127: 'Stretching',
  230: 'Table Tennis',
  231: 'Badminton',
  232: 'Netball',
  233: 'Sauna',
  234: 'Disc Golf',
  239: 'Ice Skating',
  240: 'Handball',
};

function sportNameFromId(sportId) {
  if (sportId == null) return 'Activity';
  return SPORT_NAMES[sportId] || 'Activity';
}

// Words that should render as acronyms rather than being title-cased.
const ACRONYM_WORDS = new Set(['hiit']);

function normalizeSportName(record) {
  if (record.sport_name && typeof record.sport_name === 'string') {
    const trimmed = record.sport_name.trim();
    if (!trimmed || trimmed.toLowerCase() === 'activity') return 'Activity';
    // WHOOP v2 sport_name arrives lowercase/snake_case (e.g. "running",
    // "functional_fitness"); title-case it for display, preserving
    // known acronyms like HIIT.
    return trimmed
      .split(/[_\s]+/)
      .filter(Boolean)
      .map((w) =>
        ACRONYM_WORDS.has(w.toLowerCase())
          ? w.toUpperCase()
          : w[0].toUpperCase() + w.slice(1).toLowerCase()
      )
      .join(' ');
  }
  return sportNameFromId(record.sport_id);
}

// -----------------------------------------------------------------------
// Date helpers
// -----------------------------------------------------------------------
const chicagoDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function localDate(isoOrDate) {
  if (isoOrDate == null) return null;
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return null;
  return chicagoDateFormatter.format(d); // YYYY-MM-DD
}

export function milliToMin(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  return Math.round(ms / 60000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Exported alias: `sleep` (the delay helper) vs. the "sleep" data
// collection is a confusing pairing, so history.mjs imports this as `delay`.
export { sleep as delay };

// -----------------------------------------------------------------------
// Token storage
// -----------------------------------------------------------------------
async function readTokens() {
  const raw = await fsp.readFile(TOKENS_PATH, 'utf8');
  return JSON.parse(raw);
}

async function writeTokensAtomic(tokens) {
  const dir = path.dirname(TOKENS_PATH);
  const tmpPath = path.join(dir, `.tokens.json.${process.pid}.${Date.now()}.tmp`);
  await fsp.writeFile(tmpPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  await fsp.chmod(tmpPath, 0o600);
  await fsp.rename(tmpPath, TOKENS_PATH);
}

function isExpired(tokens) {
  if (!tokens || !tokens.expires_at) return true;
  // Refresh a minute early to avoid racing expiry mid-request.
  return Date.now() >= tokens.expires_at - 60_000;
}

async function readClientCredentials() {
  const raw = await fsp.readFile(CLAUDE_CONFIG_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  const env = cfg?.mcpServers?.whoop?.env;
  const clientId = env?.WHOOP_CLIENT_ID;
  const clientSecret = env?.WHOOP_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'WHOOP client credentials not found at mcpServers.whoop.env in ~/.claude.json'
    );
  }
  return { clientId, clientSecret };
}

async function refreshTokens(oldTokens) {
  const { clientId, clientSecret } = await readClientCredentials();
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: oldTokens.refresh_token,
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'offline',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Token refresh failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const expiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
  // Preserve the original file's key shape; only update the fields we own.
  const newTokens = {
    ...oldTokens,
    access_token: data.access_token,
    refresh_token: data.refresh_token || oldTokens.refresh_token,
    expires_at: expiresAt,
    token_type: data.token_type || oldTokens.token_type,
  };
  await writeTokensAtomic(newTokens);
  return newTokens;
}

export async function getValidTokens() {
  let tokens = await readTokens();
  if (isExpired(tokens)) {
    tokens = await refreshTokens(tokens);
  }
  return tokens;
}

// Convenience wrapper: the { tokens, _refreshing } bag threaded through
// apiFetch/fetchRecordsPage/fetchAllRecords calls. Callers outside this
// module (e.g. history.mjs) should get one of these per logical operation
// rather than building the shape by hand.
export async function getAuthedContext() {
  const tokens = await getValidTokens();
  return { tokens, _refreshing: null };
}

function authHeader(tokens) {
  const rawType = tokens.token_type || 'Bearer';
  const type = rawType[0].toUpperCase() + rawType.slice(1);
  return { Authorization: `${type} ${tokens.access_token}` };
}

// -----------------------------------------------------------------------
// HTTP layer: shared 401-refresh (deduped) and 429-retry handling.
// `ctx` is a mutable { tokens, _refreshing } bag threaded through a single
// getDashboard() call so a refresh triggered by one in-flight request is
// reused by any others racing against it.
// -----------------------------------------------------------------------
async function refreshShared(ctx) {
  if (!ctx._refreshing) {
    ctx._refreshing = refreshTokens(ctx.tokens)
      .then((t) => {
        ctx.tokens = t;
        ctx._refreshing = null;
        return t;
      })
      .catch((err) => {
        ctx._refreshing = null;
        throw err;
      });
  }
  return ctx._refreshing;
}

export async function apiFetch(url, ctx, { retried401 = false, retried429 = false } = {}) {
  const res = await fetch(url, {
    headers: authHeader(ctx.tokens),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (res.status === 401 && !retried401) {
    await refreshShared(ctx);
    return apiFetch(url, ctx, { retried401: true, retried429 });
  }

  if (res.status === 429 && !retried429) {
    const retryAfterHeader = res.headers.get('retry-after');
    const delaySec = retryAfterHeader ? Number(retryAfterHeader) : 1;
    await sleep((Number.isFinite(delaySec) && delaySec > 0 ? delaySec : 1) * 1000);
    return apiFetch(url, ctx, { retried401, retried429: true });
  }

  return res;
}

// -----------------------------------------------------------------------
// Paginated collection fetch, with v1 fallback on 404.
//
// fetchRecordsPage is the single-page primitive (exported so history.mjs
// can drive its own resumable, throttled, progress-reporting pagination
// loop); fetchAllRecords is the original all-at-once helper built on top
// of it, kept for getDashboard()'s bounded 30-day window.
// -----------------------------------------------------------------------
export async function fetchRecordsPage(
  kind,
  { start, end, limit = 25, nextToken, useV1 = false } = {},
  ctx
) {
  const base = useV1 ? V1_PATHS[kind] : V2_PATHS[kind];
  const url = new URL(API_BASE + base);
  url.searchParams.set('start', start);
  url.searchParams.set('end', end);
  url.searchParams.set('limit', String(limit));
  if (nextToken) url.searchParams.set('nextToken', nextToken);

  const res = await apiFetch(url, ctx);

  if (res.status === 404 && !useV1) {
    return { notFound: true, records: [], nextToken: null };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${kind} fetch failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const body = await res.json();
  return {
    notFound: false,
    records: body.records || [],
    nextToken: body.next_token || null,
  };
}

export async function fetchAllRecords(kind, { start, end, limit = 25 }, ctx, notes) {
  let useV1 = false;
  let nextToken;
  const records = [];

  for (;;) {
    const page = await fetchRecordsPage(kind, { start, end, limit, nextToken, useV1 }, ctx);

    if (page.notFound && !useV1) {
      useV1 = true;
      nextToken = undefined;
      records.length = 0;
      continue;
    }

    records.push(...page.records);
    nextToken = page.nextToken;
    if (!nextToken) break;
  }

  if (useV1) notes.v1Fallbacks.push(kind);
  return records;
}

export async function fetchProfile(ctx, notes) {
  let res = await apiFetch(new URL(API_BASE + '/v2/user/profile/basic'), ctx);
  if (res.status === 404) {
    notes.v1Fallbacks.push('profile');
    res = await apiFetch(new URL(API_BASE + '/v1/user/profile/basic'), ctx);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`profile fetch failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return {
    firstName: data.first_name ?? null,
    lastName: data.last_name ?? null,
  };
}

// Body measurement (height/weight/max HR) lives on a separate v2 endpoint.
// Cache-tolerant: any failure here should not take down the rest of the
// dashboard, so callers get nulls back rather than a thrown error.
export async function fetchBodyMeasurement(ctx, notes) {
  try {
    const res = await apiFetch(new URL(API_BASE + '/v2/user/measurement/body'), ctx);
    if (!res.ok) {
      notes.bodyMeasurementError = `HTTP ${res.status}`;
      return { heightM: null, weightKg: null, maxHr: null };
    }
    const data = await res.json();
    return {
      heightM: data.height_meter ?? null,
      weightKg: data.weight_kilogram ?? null,
      maxHr: data.max_heart_rate ?? null,
    };
  } catch (err) {
    notes.bodyMeasurementError = err && err.message ? err.message : String(err);
    return { heightM: null, weightKg: null, maxHr: null };
  }
}

// -----------------------------------------------------------------------
// Normalizers
// -----------------------------------------------------------------------
export function normalizeRecovery(r) {
  const scored = r.score_state === 'SCORED';
  const score = r.score || {};
  // Recovery records carry no start/end of their own (they're keyed off
  // cycle_id/sleep_id); created_at is the closest available proxy for
  // "when this record's period ended".
  return {
    date: localDate(r.created_at || r.updated_at),
    score: scored ? score.recovery_score ?? null : null,
    rhr: scored ? score.resting_heart_rate ?? null : null,
    hrv: scored ? score.hrv_rmssd_milli ?? null : null,
    spo2: scored ? score.spo2_percentage ?? null : null,
    skinTempC: scored ? score.skin_temp_celsius ?? null : null,
    calibrating: score.user_calibrating ?? null,
  };
}

export function normalizeSleep(r) {
  const scored = r.score_state === 'SCORED';
  const score = r.score || {};
  const stage = score.stage_summary || {};
  const need = score.sleep_needed || {};

  const hasNeed =
    need.baseline_milli != null ||
    need.need_from_sleep_debt_milli != null ||
    need.need_from_recent_strain_milli != null ||
    need.need_from_recent_nap_milli != null;
  const needMs = hasNeed
    ? (need.baseline_milli || 0) +
      (need.need_from_sleep_debt_milli || 0) +
      (need.need_from_recent_strain_milli || 0) -
      (need.need_from_recent_nap_milli || 0)
    : null;

  // Respiratory rate arrives as a float breaths/min value (e.g. 15.7);
  // round to 1 decimal for display, keep null when unscored/absent.
  const respiratoryRateBpm =
    scored && typeof score.respiratory_rate === 'number'
      ? Math.round(score.respiratory_rate * 10) / 10
      : null;

  return {
    date: localDate(r.end || r.start || r.created_at),
    performancePct: scored ? score.sleep_performance_percentage ?? null : null,
    durationMin: milliToMin(stage.total_in_bed_time_milli),
    needMin: milliToMin(needMs),
    efficiencyPct: scored ? score.sleep_efficiency_percentage ?? null : null,
    consistencyPct: scored ? score.sleep_consistency_percentage ?? null : null,
    respiratoryRateBpm,
    debtMin: milliToMin(need.need_from_sleep_debt_milli),
    stages: {
      deepMin: milliToMin(stage.total_slow_wave_sleep_time_milli),
      remMin: milliToMin(stage.total_rem_sleep_time_milli),
      lightMin: milliToMin(stage.total_light_sleep_time_milli),
      awakeMin: milliToMin(stage.total_awake_time_milli),
    },
    start: r.start ?? null,
    end: r.end ?? null,
    naps: 0, // filled in by buildSleepArray()
  };
}

export function normalizeCycle(r) {
  const scored = r.score_state === 'SCORED';
  const score = r.score || {};
  return {
    date: localDate(r.end || r.start || r.created_at),
    // start/end are carried through because the heart-rate monitor needs the
    // cycle's real duration to turn cumulative energy into a per-minute rate,
    // and needs `end === null` to recognise the in-progress cycle.
    start: r.start ?? null,
    end: r.end ?? null,
    strain: scored ? score.strain ?? null : null,
    // NOT rounded: kilojoule is the only fractional figure WHOOP publishes on
    // a cycle, and the heart-rate estimate depends on its precision. Rounding
    // to whole kJ quantises the derived bpm badly over short spans.
    kilojoules: scored && score.kilojoule != null ? score.kilojoule : null,
    kilojoulesRounded: scored && score.kilojoule != null ? Math.round(score.kilojoule) : null,
    avgHr: scored ? score.average_heart_rate ?? null : null,
    maxHr: scored ? score.max_heart_rate ?? null : null,
  };
}

export function normalizeWorkout(r) {
  const scored = r.score_state === 'SCORED';
  const score = r.score || {};
  const durationMin =
    r.start && r.end ? Math.round((new Date(r.end) - new Date(r.start)) / 60000) : null;

  // v2 workout score field is `zone_durations` (plural), with milli-duration
  // members zone_zero_milli..zone_five_milli. We only surface z1-z5 (zone
  // zero is "no zone"/rest time and isn't part of the requested shape).
  // Tolerate a hypothetical singular `zone_duration` too, and be robust to
  // the field disappearing entirely on an unscored record.
  const zoneDurations = score.zone_durations || score.zone_duration || {};
  const zones = scored
    ? {
        z1Min: milliToMin(zoneDurations.zone_one_milli),
        z2Min: milliToMin(zoneDurations.zone_two_milli),
        z3Min: milliToMin(zoneDurations.zone_three_milli),
        z4Min: milliToMin(zoneDurations.zone_four_milli),
        z5Min: milliToMin(zoneDurations.zone_five_milli),
      }
    : { z1Min: null, z2Min: null, z3Min: null, z4Min: null, z5Min: null };

  return {
    date: localDate(r.end || r.start || r.created_at),
    sport: normalizeSportName(r),
    start: r.start ?? null,
    durationMin,
    strain: scored ? score.strain ?? null : null,
    avgHr: scored ? score.average_heart_rate ?? null : null,
    maxHr: scored ? score.max_heart_rate ?? null : null,
    kilojoules: scored && score.kilojoule != null ? Math.round(score.kilojoule) : null,
    zones,
  };
}

export function dateDesc(a, b) {
  if (a.date == null && b.date == null) return 0;
  if (a.date == null) return 1;
  if (b.date == null) return -1;
  return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
}

export function buildSleepArray(rawSleepRecords) {
  const napCountByDate = {};
  for (const r of rawSleepRecords) {
    if (r.nap) {
      const d = localDate(r.end || r.start || r.created_at);
      if (d) napCountByDate[d] = (napCountByDate[d] || 0) + 1;
    }
  }
  return rawSleepRecords
    .filter((r) => !r.nap)
    .map(normalizeSleep)
    .map((s) => ({ ...s, naps: napCountByDate[s.date] || 0 }))
    .sort(dateDesc);
}

// -----------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------
export async function getDashboard({ days = 30 } = {}) {
  const tokens = await getValidTokens();
  const ctx = { tokens, _refreshing: null };
  const notes = { v1Fallbacks: [] };

  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const range = { start: start.toISOString(), end: end.toISOString() };

  const [recoveryRaw, sleepRaw, cycleRaw, workoutRaw, profileBasic, bodyMeasurement] =
    await Promise.all([
      fetchAllRecords('recovery', range, ctx, notes),
      fetchAllRecords('sleep', range, ctx, notes),
      fetchAllRecords('cycle', range, ctx, notes),
      fetchAllRecords('workout', range, ctx, notes),
      fetchProfile(ctx, notes),
      fetchBodyMeasurement(ctx, notes),
    ]);

  const profile = { ...profileBasic, ...bodyMeasurement };

  const dashboard = {
    generatedAt: new Date().toISOString(),
    profile,
    recovery: recoveryRaw.map(normalizeRecovery).sort(dateDesc),
    sleep: buildSleepArray(sleepRaw),
    cycles: cycleRaw.map(normalizeCycle).sort(dateDesc),
    workouts: workoutRaw.map(normalizeWorkout).sort(dateDesc),
  };

  if (notes.v1Fallbacks.length) {
    process.stderr.write(`[whoop-client] used v1 fallback for: ${notes.v1Fallbacks.join(', ')}\n`);
  }
  if (notes.bodyMeasurementError) {
    process.stderr.write(
      `[whoop-client] body measurement fetch failed (non-fatal): ${notes.bodyMeasurementError}\n`
    );
  }

  await fsp.writeFile(CACHE_FILE, JSON.stringify(dashboard, null, 2), 'utf8');

  return dashboard;
}

export async function getCached() {
  try {
    const raw = await fsp.readFile(CACHE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

// -----------------------------------------------------------------------
// CLI test mode: `node src/whoop-client.mjs --test`
// -----------------------------------------------------------------------
async function runTestMode() {
  const dashboard = await getDashboard({ days: 30 });
  const todayStr = localDate(new Date());
  const todayRecovery = dashboard.recovery.find((r) => r.date === todayStr);

  const newestSleep = dashboard.sleep[0] || null;
  const workoutWithZones = dashboard.workouts.find(
    (w) => w.zones && Object.values(w.zones).some((v) => v != null)
  );

  const summary = {
    counts: {
      recovery: dashboard.recovery.length,
      sleep: dashboard.sleep.length,
      cycles: dashboard.cycles.length,
      workouts: dashboard.workouts.length,
    },
    todayRecoveryScore: todayRecovery ? todayRecovery.score : null,
    newestSleepPerformancePct: dashboard.sleep[0]?.performancePct ?? null,
    profileFirstName: dashboard.profile.firstName,
    newFields: {
      sleepHasRespiratoryRate: newestSleep ? newestSleep.respiratoryRateBpm != null : null,
      sleepHasDebtMin: newestSleep ? newestSleep.debtMin != null : null,
      workoutZonesSampleFound: !!workoutWithZones,
      workoutZoneKeys: workoutWithZones ? Object.keys(workoutWithZones.zones) : null,
      profileHasHeightM: dashboard.profile.heightM != null,
      profileHasWeightKg: dashboard.profile.weightKg != null,
      profileHasMaxHr: dashboard.profile.maxHr != null,
    },
  };

  console.log(JSON.stringify(summary, null, 2));
}

const isMainModule = (() => {
  const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
  return invoked && fs.existsSync(invoked) && fs.realpathSync(invoked) === fileURLToPath(import.meta.url);
})();

if (isMainModule && process.argv.includes('--test')) {
  runTestMode().catch((err) => {
    console.error('Test run failed:', err && err.message ? err.message : err);
    process.exitCode = 1;
  });
}
