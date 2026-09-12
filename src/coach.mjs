// AI coach for whoop-desk: answers questions about the user's WHOOP data.
//
// Node >= 20, ESM. Runs in the Electron MAIN process.
//
// Model: Claude Sonnet 5 at medium effort, on the user's own Anthropic account.
//
// Credential resolution, in order:
//   1. An API key the user pasted into Settings (settings.anthropicApiKey),
//      or ANTHROPIC_API_KEY in the app's environment  -> official SDK, api.anthropic.com
//   2. The `claude` CLI, which is signed in to the user's Anthropic account
//      via OAuth                                        -> `claude -p`
//
// Sandbox hygiene: if the app was launched from a Claude Code / agent shell,
// its environment carries ANTHROPIC_BASE_URL=http://127.0.0.1:<port> and an
// ANTHROPIC_AUTH_TOKEN for that session's private credential broker. Those
// must never be used here (they yield "503 no accounts available"), so both
// the SDK client and the CLI child process get a scrubbed environment.
//
// Exports:
//   - coachStatus({ apiKey }) -> { available, source: 'api' | 'cli' | null, model }
//   - askCoach({ question, history, context, apiKey })
//       -> { reply, source, model } | { reply: null, error, source }

import Anthropic from '@anthropic-ai/sdk';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export const MODEL = 'claude-sonnet-5';
export const EFFORT = 'medium';
const API_BASE_URL = 'https://api.anthropic.com';
const MAX_TOKENS = 2048;
const CLI_TIMEOUT_MS = 120000;

const SYSTEM_PROMPT_BASE = `You are the in-app coach for Whoop+, a personal WHOOP dashboard. You talk to one person about their own recovery, sleep, and strain, in the voice of a sharp, warm human coach who knows their numbers cold.

## Data you have
The "Context" JSON below is the user's real WHOOP data. Use ONLY it. Never invent, estimate, or extrapolate numbers that are not there. If something is missing, say what is missing in one short clause and answer with what you do have.

How to read it:
- now: the current local date/time. "today" = now.today. "last night" = the sleep record with the newest date (a sleep's date is the morning it ended). "this morning's recovery" = the recovery record with the newest date.
- recovery[]: recoveryPct (0-100, WHOOP colors: 67+ green, 34-66 yellow, 0-33 red), hrvMs, rhrBpm, spo2Pct, skinTempC.
- sleep[]: performancePct (sleep got vs sleep needed), bedtime/wakeTime (local), asleep vs need, debtMin, efficiencyPct (time asleep / time in bed), consistencyPct (bed/wake timing vs prior days), respiratoryRateBpm, stages (deep, rem, light, awake), naps.
- cycles[]: dayStrain (0-21 scale: <10 light, 10-14 moderate, 14-18 high, 18+ all out), calories, avgHr, maxHr.
- workouts[]: per-activity strain, duration, HR, calories, minutes in HR zones z1-z5.
- baselines28d: 28-day mean and sd for each key metric. "Your usual" = the mean. Meaningfully different = roughly one sd or more away.
- sleepDebt7d, acwr (acute:chronic workload ratio; <0.8 undertraining, 0.8-1.3 sweet spot, >1.5 spike), strainTarget (today's recommended strain range from this morning's recovery), journal (user-logged tags/notes).

## How to answer
- Lead with the answer in one sentence. Then the supporting numbers. No preamble like "Here's the breakdown".
- Always anchor a number against the user's own baseline in plain words ("HRV 44 ms vs your usual ~84"). Do not print z-scores, standard deviations, or the word "dataset" unless the user asks for statistics.
- For any "break down" / "how was my X" request, cover every relevant field: for sleep that means performance, need vs got, bedtime and wake time, efficiency, each stage with its share of the night, awake time, consistency, respiratory rate, naps, and how it fed into the morning's recovery.
- Use the pre-formatted values ("7h 03m", local times) rather than raw minutes when both exist. Percentages as whole numbers.
- Finish with exactly one concrete, specific action for the rest of today or tonight, tied to a number in the data (a bedtime, a strain ceiling, a workout choice).
- Length: simple question, under 80 words. Breakdown, 120-200 words. Never pad.
- Formatting: light Markdown only. Bold the 2-4 numbers that matter most. Use short bullets for breakdowns, plain sentences otherwise. No headings, no tables, no emoji.
- Tone: direct, encouraging, specific. Talk like a coach who has been watching this person's data for weeks, not a report generator.
- Medical: you are not a clinician. Only if the user brings up symptoms, illness, or medication, add one brief sentence saying this is data insight, not medical advice, and suggest a professional if it persists. Otherwise never mention it.
- Remember earlier turns of the conversation and do not repeat numbers you already gave unless asked.`;

// -----------------------------------------------------------------------
// Environment scrubbing
// -----------------------------------------------------------------------
function isLoopbackUrl(value) {
  if (!value) return false;
  try {
    const host = new URL(value).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

// Returns a copy of process.env with any agent-session broker credentials
// removed, so nested SDK/CLI calls hit the real Anthropic API with the
// user's own credentials.
// Directories where the claude CLI is commonly installed. A GUI app launched
// from the Dock/Finder only gets /usr/bin:/bin:/usr/sbin:/sbin, so these are
// appended to PATH for every child process and searched directly.
const CLI_DIRS = [
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), '.claude', 'local'),
  path.join(os.homedir(), '.npm-global', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
];

function augmentedPath(current) {
  const parts = (current || '').split(path.delimiter).filter(Boolean);
  for (const dir of CLI_DIRS) if (!parts.includes(dir)) parts.push(dir);
  return parts.join(path.delimiter);
}

export function cleanEnv(base = process.env) {
  const env = { ...base };
  env.PATH = augmentedPath(env.PATH);
  const brokered = isLoopbackUrl(env.ANTHROPIC_BASE_URL);
  if (brokered) {
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_AUTH_TOKEN; // token is only valid against the broker
  }
  // Nested-session markers from a parent Claude Code process; a child
  // `claude -p` should start clean rather than think it is a subagent.
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_') || key === 'CLAUDE_PID' || key === 'CLAUDE_JOB_DIR') {
      delete env[key];
    }
  }
  return env;
}

function resolveApiKey(explicitKey) {
  const fromSettings = typeof explicitKey === 'string' ? explicitKey.trim() : '';
  if (fromSettings) return fromSettings;
  const env = cleanEnv();
  const fromEnv = (env.ANTHROPIC_API_KEY || '').trim();
  return fromEnv || null;
}

// -----------------------------------------------------------------------
// Availability detection
// -----------------------------------------------------------------------
let cliPathCache = null; // only successful lookups are cached

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export async function findClaudeCli() {
  if (cliPathCache && isExecutable(cliPathCache)) return cliPathCache;
  cliPathCache = null;

  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const env = cleanEnv();
  for (const dir of env.PATH.split(path.delimiter)) {
    const candidate = path.join(dir, exe);
    if (dir && isExecutable(candidate)) {
      cliPathCache = candidate;
      return cliPathCache;
    }
  }

  // Last resort: ask the shell (covers unusual layouts / shims).
  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(whichCmd, ['claude'], { env });
    const found = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (found && isExecutable(found)) cliPathCache = found;
  } catch {
    /* not found */
  }
  return cliPathCache;
}

export async function coachStatus({ apiKey } = {}) {
  if (resolveApiKey(apiKey)) {
    return { available: true, source: 'api', model: MODEL, effort: EFFORT };
  }
  if (await findClaudeCli()) {
    return { available: true, source: 'cli', model: MODEL, effort: EFFORT };
  }
  return { available: false, source: null, model: MODEL, effort: EFFORT };
}

// -----------------------------------------------------------------------
// Shared prompt construction
// -----------------------------------------------------------------------
function buildSystemPrompt(context) {
  const contextJson = JSON.stringify(context ?? {}, null, 2);
  return `${SYSTEM_PROMPT_BASE}\n\n## Context\n${contextJson}`;
}

function shortError(err) {
  const message = (err && err.message) || String(err);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

function statusOf(err) {
  return err?.status ?? err?.statusCode ?? null;
}

// -----------------------------------------------------------------------
// API path (official SDK, user's API key)
// -----------------------------------------------------------------------
function extractText(response) {
  return (response?.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

async function askViaApi({ question, history, context, apiKey }) {
  const system = buildSystemPrompt(context);
  const messages = [
    ...(history || []).map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: question },
  ];

  // Explicit baseURL + apiKey so no session broker env can leak in.
  const client = new Anthropic({ apiKey, baseURL: API_BASE_URL });

  const base = { model: MODEL, max_tokens: MAX_TOKENS, system, messages };
  let response;
  try {
    response = await client.messages.create({
      ...base,
      thinking: { type: 'adaptive' },
      output_config: { effort: EFFORT },
    });
  } catch (err) {
    if (statusOf(err) !== 400) {
      return { reply: null, error: shortError(err), source: 'api', status: statusOf(err) };
    }
    // Older API surface that rejects the thinking/effort params — retry plain.
    try {
      response = await client.messages.create(base);
    } catch (err2) {
      return { reply: null, error: shortError(err2), source: 'api', status: statusOf(err2) };
    }
  }

  if (response.stop_reason === 'refusal') {
    return {
      reply: "I can't help with that one — let's try a different question about your data.",
      source: 'api',
      model: MODEL,
    };
  }

  return { reply: extractText(response), source: 'api', model: MODEL };
}

// -----------------------------------------------------------------------
// CLI path (`claude -p`, signed in to the user's account via OAuth)
// -----------------------------------------------------------------------
function buildCliPrompt({ question, history }) {
  const historyText = (history || [])
    .map((h) => `${h.role === 'assistant' ? 'Coach' : 'User'}: ${h.content}`)
    .join('\n');
  return [historyText, `User: ${question}`].filter(Boolean).join('\n\n');
}

async function askViaCli({ question, history, context }) {
  const cli = await findClaudeCli();
  if (!cli) return { reply: null, error: 'The claude CLI is not installed.', source: 'cli' };

  const args = [
    '-p', buildCliPrompt({ question, history }),
    '--system-prompt', buildSystemPrompt(context),
    '--model', MODEL,
    '--effort', EFFORT,
    '--output-format', 'json',
    '--tools', '',
    '--no-session-persistence',
  ];

  let stdout;
  try {
    ({ stdout } = await execFileAsync(cli, args, {
      env: cleanEnv(),
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    }));
  } catch (err) {
    const detail = (err && (err.stderr || err.stdout || err.message)) || String(err);
    return { reply: null, error: shortError({ message: String(detail).trim() }), source: 'cli' };
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { reply: null, error: 'Could not parse the claude CLI response as JSON.', source: 'cli' };
  }

  if (parsed && parsed.is_error) {
    return { reply: null, error: shortError({ message: parsed.result || 'claude CLI reported an error.' }), source: 'cli' };
  }
  if (parsed && typeof parsed.result === 'string') {
    return { reply: parsed.result.trim(), source: 'cli', model: MODEL };
  }
  return { reply: null, error: 'claude CLI response was missing a "result" field.', source: 'cli' };
}

// -----------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------
export async function askCoach({ question, history = [], context, apiKey } = {}) {
  const key = resolveApiKey(apiKey);
  const cli = await findClaudeCli();

  if (!key && !cli) {
    return {
      reply: null,
      error: 'No Anthropic credentials found — sign in with the claude CLI (`claude auth login`) or paste an API key in Settings.',
      source: null,
    };
  }

  if (key) {
    const viaApi = await askViaApi({ question, history, context, apiKey: key });
    // Server-side trouble with the key path: fall through to the signed-in CLI.
    const status = viaApi.status;
    if (viaApi.reply != null || !cli || !(status == null || status >= 500 || status === 401 || status === 403)) {
      if (viaApi.reply == null && (status === 401 || status === 403)) {
        viaApi.error = `Anthropic rejected the API key in Settings (${status}). Clear that field to use the signed-in claude CLI instead, or paste a valid key.`;
      }
      return viaApi;
    }
  }

  return askViaCli({ question, history, context });
}
