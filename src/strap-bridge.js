// Supervisor for the native CoreBluetooth helper (native/hr-bridge.swift).
//
// The helper owns the Bluetooth connection and prints one JSON object per line
// on stdout. This module spawns it, turns that stream into events, and keeps it
// alive. Web Bluetooth is not involved anywhere: Chromium requires a real user
// gesture before it will scan, which is exactly why the app used to need a
// "Connect strap" click.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const RESTART_MIN_MS = 2000;
const RESTART_MAX_MS = 30000;

/// The helper ships as an extraResource in the packaged app and lives under
/// native/bin in a dev checkout.
function resolveBinary() {
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'hr-bridge'));
  }
  candidates.push(path.join(__dirname, '..', 'native', 'bin', 'hr-bridge'));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * Start the helper and stream its events.
 *
 * @param {object} opts
 * @param {(event: object) => void} opts.onEvent   parsed JSON line
 * @param {string|null} [opts.preferredId]         peripheral UUID to prefer
 * @returns {{ stop: () => void, available: boolean, binary: string|null }}
 */
function createStrapBridge({ onEvent, preferredId = null } = {}) {
  const binary = resolveBinary();
  if (!binary) {
    console.error('strap-bridge: helper binary not found; strap is unavailable');
    return { stop() {}, available: false, binary: null };
  }

  let child = null;
  let stopped = false;
  let restartDelay = RESTART_MIN_MS;
  let restartTimer = null;
  let stdoutTail = '';

  const emit = (event) => {
    try {
      onEvent(event);
    } catch (err) {
      console.error('strap-bridge: event handler threw:', err);
    }
  };

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      console.error('strap-bridge: unparseable line:', trimmed.slice(0, 200));
      return;
    }
    if (parsed && typeof parsed.t === 'string') emit(parsed);
  };

  const spawnChild = () => {
    if (stopped) return;
    const args = preferredId ? [preferredId] : [];
    try {
      child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      console.error('strap-bridge: spawn failed:', err);
      scheduleRestart();
      return;
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutTail += chunk;
      const lines = stdoutTail.split('\n');
      stdoutTail = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) console.error('strap-bridge(helper):', text.slice(0, 400));
    });

    child.on('error', (err) => {
      console.error('strap-bridge: child error:', err);
    });

    child.on('exit', (code, signal) => {
      child = null;
      stdoutTail = '';
      if (stopped) return;
      console.error(`strap-bridge: helper exited (code=${code} signal=${signal}); restarting`);
      emit({ t: 'state', v: 'disconnected' });
      scheduleRestart();
    });

    // A clean spawn resets the backoff, so a one-off crash does not slow down
    // every later restart.
    restartDelay = RESTART_MIN_MS;
  };

  const scheduleRestart = () => {
    if (stopped || restartTimer) return;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      spawnChild();
    }, restartDelay);
    restartDelay = Math.min(RESTART_MAX_MS, Math.round(restartDelay * 1.8));
  };

  spawnChild();

  return {
    available: true,
    binary,
    stop() {
      stopped = true;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      if (child) {
        // Closing stdin is the helper's own shutdown signal; kill is a backstop.
        try { child.stdin.end(); } catch { /* already gone */ }
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        child = null;
      }
    },
  };
}

module.exports = { createStrapBridge, resolveBinary };
