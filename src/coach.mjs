// AI coach for whoop-desk: answers questions about the user's WHOOP data,
// backed by the Claude API (preferred) or the `claude` CLI (fallback).
//
// Node >= 20, ESM. Runs in the Electron MAIN process.
//
// Credential resolution is entirely delegated to the official SDK
// (`new Anthropic()` with zero args) — it resolves ANTHROPIC_API_KEY,
// ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile automatically.
// Never hardcode a key here.
//
// Exports:
//   - coachStatus() -> { available, source: 'api' | 'cli' | null }
//   - askCoach({ question, history, context }) -> { reply, source } | { reply: null, error, source }

import Anthropic from '@anthropic-ai/sdk';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const MODEL = 'claude-opus-5';
const MAX_TOKENS = 2048;
const CLI_TIMEOUT_MS = 120000;

const SYSTEM_PROMPT_BASE = [
  "You are a personal health-data coach for a WHOOP wearable user, embedded in their desktop dashboard app.",
  'Ground every answer ONLY in the data given to you in the "Context" section below — never invent numbers, trends, or data you have not been given.',
  'Be concise and specific: reference the actual numbers in the context (recovery score, HRV, RHR, sleep stages, strain, etc.) rather than speaking in generalities.',
  "If the conversation touches on symptoms, illness, or something that sounds medical, note once (not on every message) that you are not a medical professional and this is not medical advice — then still answer helpfully from the data.",
  'If the context does not contain the information needed to answer, say so plainly instead of guessing.',
].join(' ');

// -----------------------------------------------------------------------
// Credential / availability detection
// -----------------------------------------------------------------------
function hasApiCredentials() {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return true;
  try {
    const profileDir = path.join(os.homedir(), '.config', 'anthropic');
    return fs.existsSync(profileDir);
  } catch {
    return false;
  }
}

async function hasClaudeCli() {
  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    await execFileAsync(whichCmd, ['claude']);
    return true;
  } catch {
    return false;
  }
}

export async function coachStatus() {
  if (hasApiCredentials()) {
    return { available: true, source: 'api' };
  }
  if (await hasClaudeCli()) {
    return { available: true, source: 'cli' };
  }
  return { available: false, source: null };
}

// -----------------------------------------------------------------------
// Shared prompt construction
// -----------------------------------------------------------------------
function buildSystemPrompt(context) {
  const contextJson = JSON.stringify(context ?? {}, null, 2);
  return `${SYSTEM_PROMPT_BASE}\n\nContext (JSON — the user's recent WHOOP data, baselines, and/or journal):\n${contextJson}`;
}

function shortError(err) {
  const message = (err && err.message) || String(err);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

// -----------------------------------------------------------------------
// API path
// -----------------------------------------------------------------------
function looksLikeUnknownParamError(err) {
  const status = err?.status ?? err?.statusCode;
  const message = String(err?.message || '');
  if (status === 400) return true;
  return /unknown parameter|unrecognized|unexpected keyword|beta|fallback/i.test(message);
}

function extractText(response) {
  const block = (response?.content || []).find((b) => b.type === 'text');
  return block?.text ?? '';
}

async function askViaApi({ question, history, context }) {
  const system = buildSystemPrompt(context);
  const messages = [
    ...(history || []).map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: question },
  ];

  const client = new Anthropic();

  let response;
  try {
    response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
  } catch (err) {
    if (!looksLikeUnknownParamError(err)) {
      return { reply: null, error: shortError(err), source: 'api' };
    }
    // Older SDK / API that doesn't know about server-side fallbacks yet —
    // retry once with the plain (non-beta) call.
    try {
      response = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system,
        messages,
      });
    } catch (err2) {
      return { reply: null, error: shortError(err2), source: 'api' };
    }
  }

  if (response.stop_reason === 'refusal') {
    return {
      reply: "I can't help with that one — let's try a different question about your data.",
      source: 'api',
    };
  }

  return { reply: extractText(response), source: 'api' };
}

// -----------------------------------------------------------------------
// CLI fallback path
// -----------------------------------------------------------------------
function buildCliPrompt({ question, history, context }) {
  const system = buildSystemPrompt(context);
  const historyText = (history || [])
    .map((h) => `${h.role === 'assistant' ? 'Coach' : 'User'}: ${h.content}`)
    .join('\n');
  return [system, historyText, `User: ${question}`].filter(Boolean).join('\n\n');
}

async function askViaCli({ question, history, context }) {
  const fullPrompt = buildCliPrompt({ question, history, context });

  let stdout;
  try {
    ({ stdout } = await execFileAsync('claude', ['-p', fullPrompt, '--output-format', 'json'], {
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    }));
  } catch (err) {
    return { reply: null, error: shortError(err), source: 'cli' };
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { reply: null, error: 'Could not parse the claude CLI response as JSON.', source: 'cli' };
  }

  if (parsed && typeof parsed.result === 'string') {
    return { reply: parsed.result, source: 'cli' };
  }
  return { reply: null, error: 'claude CLI response was missing a "result" field.', source: 'cli' };
}

// -----------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------
export async function askCoach({ question, history = [], context } = {}) {
  const status = await coachStatus();

  if (!status.available) {
    return {
      reply: null,
      error: 'No Claude credentials or CLI found — set ANTHROPIC_API_KEY, run `ant auth login`, or install the claude CLI.',
      source: null,
    };
  }

  if (status.source === 'api') {
    return askViaApi({ question, history, context });
  }
  return askViaCli({ question, history, context });
}
