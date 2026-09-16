const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
} = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');

const isSmoke = process.argv.includes('--smoke');
const isIpcCheck = process.argv.includes('--ipc-check');

// Optional `--size=WIDTHxHEIGHT` override, used to spot-check the responsive
// layout at a second window size (e.g. `npm run smoke -- --size=1024x700`).
function windowSize() {
  const defaults = { width: 1280, height: 820 };
  const arg = process.argv.find((a) => a.startsWith('--size='));
  if (!arg) return defaults;
  const match = /^--size=(\d{3,5})x(\d{3,5})$/.exec(arg);
  if (!match) return defaults;
  return { width: Number(match[1]), height: Number(match[2]) };
}

app.setName('Whoop+');

// Chromium's newer Web Bluetooth permissions backend remembers granted
// devices across launches, which lets navigator.bluetooth.getDevices()
// reconnect to the strap without a chooser — the basis of auto-connect.
app.commandLine.appendSwitch('enable-features', 'WebBluetoothNewPermissionsBackend');

// The packaged Whoop+.app and a dev `electron .` checkout both default to
// the same userData dir ("Whoop+"), since userData is keyed off app name.
// Running both at once causes silent single-instance-lock quits and
// localStorage/settings.json write contention. Give the dev build its own
// userData dir, set as early as possible (before app is ready, and before
// the single-instance lock is requested, since the lockfile also lives
// under userData).
if (!app.isPackaged) {
  app.setPath('userData', `${app.getPath('userData')}-dev`);
}

// Single-instance lock.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showAndFocusWindow();
  });

  let mainWindow = null;
  let tray = null;
  let lastDashboardForTray = null;
  let refreshInFlight = null;
  let autoRefreshTimer = null;
  let hrStore = null;
  let hrTimer = null;
  let morningTimer = null;
  let backfillRunning = false;

  // -----------------------------------------------------------------------
  // Lazy ESM module loaders (dynamic import caches by URL, so repeated
  // calls are cheap and always return the same module namespace object).
  // -----------------------------------------------------------------------
  async function loadWhoopClient() {
    return import('./src/whoop-client.mjs');
  }
  async function loadHistory() {
    return import('./src/history.mjs');
  }
  async function loadAnalytics() {
    return import('./src/analytics.mjs');
  }
  async function loadCoach() {
    return import('./src/coach.mjs');
  }
  async function loadExport() {
    return import('./src/export.mjs');
  }
  async function loadHrMonitor() {
    return import('./src/hr-monitor.mjs');
  }

  async function getDashboardWithFallback() {
    try {
      const client = await loadWhoopClient();
      return await client.getDashboard({ days: 30 });
    } catch (err) {
      try {
        const client = await loadWhoopClient();
        const cached = await client.getCached();
        if (cached) return cached;
      } catch (cacheErr) {
        // fall through to error object below
      }
      return { error: String(err) };
    }
  }

  // -----------------------------------------------------------------------
  // Settings: userData/settings.json, atomic write, merge on setSettings.
  // -----------------------------------------------------------------------
  const DEFAULT_SETTINGS = {
    launchAtLogin: false,
    notificationsEnabled: true,
    morningHour: 8,
    autoRefreshMins: 10,
    // Optional. When blank, the coach uses the signed-in `claude` CLI
    // (the user's own Anthropic account via OAuth).
    anthropicApiKey: '',
    // Strap features
    autoConnectStrap: true,
    restingAlertEnabled: false,
    restingAlertBpm: 100,
    // Internal, persisted alongside the user-facing settings above: tracks
    // the anomaly flag's last-known state so we only notify on a
    // false -> true transition rather than on every refresh.
    lastAnomalyFlagged: false,
  };

  let settings = { ...DEFAULT_SETTINGS };
  let settingsPath = null;

  async function loadSettings() {
    settingsPath = path.join(app.getPath('userData'), 'settings.json');
    try {
      const raw = await fsp.readFile(settingsPath, 'utf8');
      const parsed = JSON.parse(raw);
      settings = { ...DEFAULT_SETTINGS, ...parsed };
    } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        console.error('Failed to read settings.json:', err);
      }
      settings = { ...DEFAULT_SETTINGS };
    }
    return settings;
  }

  async function saveSettingsAtomic() {
    if (!settingsPath) return;
    const dir = path.dirname(settingsPath);
    await fsp.mkdir(dir, { recursive: true });
    const tmpPath = path.join(dir, `.settings.json.${process.pid}.${Date.now()}.tmp`);
    await fsp.writeFile(tmpPath, JSON.stringify(settings, null, 2), 'utf8');
    await fsp.rename(tmpPath, settingsPath);
  }

  function applyLoginItemSettings() {
    // Note: setLoginItemSettings only takes effect for the packaged
    // /Applications app; it is a no-op (or unreliable) when running via
    // `electron .` in development.
    try {
      app.setLoginItemSettings({ openAtLogin: !!settings.launchAtLogin });
    } catch (err) {
      console.error('Failed to apply login item settings:', err);
    }
  }

  // -----------------------------------------------------------------------
  // Window
  // -----------------------------------------------------------------------
  function setDockIcon() {
    if (process.platform !== 'darwin') return;
    if (!app.dock) return;
    try {
      const iconPath = path.join(__dirname, 'assets', 'icon.png');
      if (fs.existsSync(iconPath)) {
        app.dock.setIcon(iconPath);
      }
    } catch (err) {
      // Non-fatal: keep default icon if this fails.
      console.error('Failed to set dock icon:', err);
    }
  }

  function createWindow() {
    const size = windowSize();
    mainWindow = new BrowserWindow({
      width: size.width,
      height: size.height,
      minWidth: 1024,
      minHeight: 700,
      titleBarStyle: 'hiddenInset',
      backgroundColor: '#101318',
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    mainWindow.once('ready-to-show', () => {
      mainWindow.show();
    });

    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    // Web Bluetooth: Chromium fires this repeatedly as devices appear during
    // a renderer requestDevice() scan. Auto-select the WHOOP strap by name;
    // if none shows up within 25s the scan is cancelled so the renderer can
    // tell the user to enable Broadcast Heart Rate in the WHOOP app.
    let bleCancelCb = null;
    let bleCancelTimer = null;
    mainWindow.webContents.on('select-bluetooth-device', (event, devices, callback) => {
      event.preventDefault();
      const strap = devices.find((d) => /whoop/i.test(d.deviceName || ''));
      if (strap) {
        if (bleCancelTimer) clearTimeout(bleCancelTimer);
        bleCancelTimer = null;
        bleCancelCb = null;
        callback(strap.deviceId);
        return;
      }
      bleCancelCb = callback;
      if (!bleCancelTimer) {
        bleCancelTimer = setTimeout(() => {
          bleCancelTimer = null;
          if (bleCancelCb) {
            try { bleCancelCb(''); } catch (err) { /* already resolved */ }
            bleCancelCb = null;
          }
        }, 25000);
      }
    });

    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

    if (isSmoke) {
      runSmokeMode(mainWindow);
    }
  }

  function showAndFocusWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  // -----------------------------------------------------------------------
  // Renderer push events
  // -----------------------------------------------------------------------
  function pushUpdated(dashboard) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('whoop:updated', dashboard);
    }
  }

  function pushBackfillProgress(progress) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('whoop:backfillProgress', progress);
    }
  }

  // -----------------------------------------------------------------------
  // Tray (menu-bar presence)
  // -----------------------------------------------------------------------
  // Builds a small 16x16 template-style dot icon in-code (a raw BGRA
  // bitmap, no PNG decoding needed). All opaque pixels are pure black
  // (R=G=B=0), so BGRA vs RGBA channel order is irrelevant here; on
  // darwin, marking it a template image lets macOS auto-tint it for the
  // current menu bar appearance. Falls back to an empty image (title-text
  // only) if bitmap creation fails for any reason.
  function buildDotIcon() {
    try {
      const size = 16;
      const buffer = Buffer.alloc(size * size * 4);
      const cx = size / 2 - 0.5;
      const cy = size / 2 - 0.5;
      const radius = 5;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const dx = x - cx;
          const dy = y - cy;
          if (dx * dx + dy * dy <= radius * radius) {
            const idx = (y * size + x) * 4;
            buffer[idx] = 0; // B
            buffer[idx + 1] = 0; // G
            buffer[idx + 2] = 0; // R
            buffer[idx + 3] = 255; // A
          }
        }
      }
      const image = nativeImage.createFromBitmap(buffer, { width: size, height: size });
      if (process.platform === 'darwin') image.setTemplateImage(true);
      return image;
    } catch (err) {
      console.error('Failed to build tray dot icon, falling back to empty image:', err);
      return nativeImage.createEmpty();
    }
  }

  function zoneForScore(score) {
    if (score == null) return { emoji: '⚪', label: 'No data' };
    if (score >= 67) return { emoji: '🟢', label: 'green' };
    if (score >= 34) return { emoji: '🟡', label: 'yellow' };
    return { emoji: '🔴', label: 'red' };
  }

  function statsLabelFor(dashboard) {
    const recovery = Array.isArray(dashboard && dashboard.recovery) ? dashboard.recovery : [];
    const cycles = Array.isArray(dashboard && dashboard.cycles) ? dashboard.cycles : [];
    const rec = recovery.find((r) => r.hrv != null || r.rhr != null);
    const cyc = cycles.find((c) => c.strain != null);
    const hrv = rec && rec.hrv != null ? Math.round(rec.hrv) : '--';
    const rhr = rec && rec.rhr != null ? Math.round(rec.rhr) : '--';
    const strain = cyc && cyc.strain != null ? cyc.strain.toFixed(1) : '--';
    return `HRV ${hrv} · RHR ${rhr} · Strain ${strain}`;
  }

  function createTray() {
    tray = new Tray(buildDotIcon());
    tray.setToolTip('Whoop+');
    tray.on('click', showAndFocusWindow);
    updateTrayMenu();
  }

  function updateTrayMenu() {
    if (!tray) return;
    const menu = Menu.buildFromTemplate([
      { label: 'Open Whoop+', click: showAndFocusWindow },
      { label: 'Refresh now', click: () => doRefresh().catch((err) => console.error('Tray refresh failed:', err)) },
      { type: 'separator' },
      { label: statsLabelFor(lastDashboardForTray), enabled: false },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]);
    tray.setContextMenu(menu);
  }

  let trayBaseTitle = '';

  function applyTrayTitle() {
    if (!tray) return;
    const fresh = strapState.lastBeatAt && Date.now() - strapState.lastBeatAt < 15000;
    const beat = fresh && Number.isFinite(strapState.lastBpm) ? `\u2665${strapState.lastBpm} ` : '';
    tray.setTitle(`${beat}${trayBaseTitle}`);
  }

  function updateTray(dashboard) {
    if (!tray) return;
    lastDashboardForTray = dashboard;
    const recovery = Array.isArray(dashboard && dashboard.recovery) ? dashboard.recovery : [];
    const newestScore = recovery.find((r) => r.score != null)?.score ?? null;
    const zone = zoneForScore(newestScore);
    const pct = newestScore != null ? `${Math.round(newestScore)}%` : '--';
    trayBaseTitle = `${zone.emoji} ${pct}`;
    applyTrayTitle();
    updateTrayMenu();
  }

  // -----------------------------------------------------------------------
  // Refresh (manual IPC, auto-refresh timer, and powerMonitor 'resume' all
  // funnel through here; serialized so overlapping refreshes collapse into
  // one in-flight call).
  // -----------------------------------------------------------------------
  async function doRefresh() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      try {
        const client = await loadWhoopClient();
        const history = await loadHistory();
        const [dashboard] = await Promise.all([
          client.getDashboard({ days: 30 }),
          history.syncRecent({ days: 7 }).catch((err) => {
            console.error('syncRecent failed during refresh:', err);
          }),
        ]);
        pushUpdated(dashboard);
        updateTray(dashboard);
        await checkAnomalyAndNotify();
        return dashboard;
      } finally {
        refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  }

  // -----------------------------------------------------------------------
  // Strap beat stream (renderer pushes each measured Bluetooth reading)
  // -----------------------------------------------------------------------
  const strapState = {
    beats: [], // [msEpoch, bpm], rolling 4 minutes
    lastBeatAt: 0,
    lastBpm: null,
    inWorkout: false,
    lastAlertAt: 0,
    trayTick: 0,
    reverting: null,
  };

  function maybeRestingAlert() {
    if (!settings.restingAlertEnabled || !settings.notificationsEnabled) return;
    if (strapState.inWorkout) return;
    const threshold = Number(settings.restingAlertBpm) || 100;
    const now = Date.now();
    if (now - strapState.lastAlertAt < 30 * 60000) return;
    const windowBeats = strapState.beats.filter(([t]) => now - t <= 3 * 60000);
    if (windowBeats.length < 90) return; // need ~3 minutes of steady stream
    const span = windowBeats[windowBeats.length - 1][0] - windowBeats[0][0];
    if (span < 2.5 * 60000) return;
    const sorted = windowBeats.map(([, b]) => b).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median <= threshold) return;
    strapState.lastAlertAt = now;
    try {
      new Notification({
        title: `Heart rate elevated: ${median} bpm`,
        body: `Median over the last 3 minutes is above your ${threshold} bpm resting alert. Not medical advice.`,
      }).show();
    } catch (err) {
      console.error('Resting alert failed:', err);
    }
  }

  ipcMain.on('whoop:strapBeat', (event, payload) => {
    const bpm = payload && Number(payload.bpm);
    if (!Number.isFinite(bpm) || bpm < 25 || bpm > 240) return;
    const now = Date.now();
    strapState.lastBeatAt = now;
    strapState.lastBpm = Math.round(bpm);
    strapState.inWorkout = !!(payload && payload.inWorkout);
    strapState.beats.push([now, bpm]);
    const cutoff = now - 4 * 60000;
    while (strapState.beats.length && strapState.beats[0][0] < cutoff) strapState.beats.shift();

    // Tray updates at most every 5s; a lapsed stream reverts the title.
    if (now - strapState.trayTick > 5000) {
      strapState.trayTick = now;
      applyTrayTitle();
    }
    if (strapState.reverting) clearTimeout(strapState.reverting);
    strapState.reverting = setTimeout(applyTrayTitle, 16000);

    maybeRestingAlert();
  });

  // -----------------------------------------------------------------------
  // Auto-connect: nudge the renderer to try a silent strap connection. The
  // executeJavaScript userGesture flag satisfies Chromium's activation
  // requirement, and the main-process chooser auto-picks the WHOOP by name.
  // -----------------------------------------------------------------------
  const STRAP_RETRY_MINS = 3;
  let strapRetryTimer = null;

  function nudgeStrapConnect() {
    if (!settings.autoConnectStrap) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (strapState.lastBeatAt && Date.now() - strapState.lastBeatAt < 20000) return; // already streaming
    mainWindow.webContents
      .executeJavaScript('window.__tryStrapConnect && window.__tryStrapConnect(true)', true)
      .catch(() => {});
  }

  function startStrapRetryTimer() {
    if (strapRetryTimer) clearInterval(strapRetryTimer);
    strapRetryTimer = setInterval(nudgeStrapConnect, STRAP_RETRY_MINS * 60000);
  }

  // Heart-rate sampling. WHOOP publishes no HR time series, so the series is
  // reconstructed from the in-progress cycle's cumulative kilojoules (see
  // src/hr-monitor.mjs for why energy and not the integer average).
  //
  // Cadence: measured against the live API, the cycle record refreshes in
  // batches roughly every 1-2 minutes as the strap syncs. 30 seconds catches
  // each batch promptly and costs 2,880 calls a day against a published
  // ceiling of 100/minute and 10,000/day. Unchanged reads are discarded by
  // the store, so a fast poll adds no false points.
  const HR_SAMPLE_SECONDS = 30;

  // Live mode: the user holds the button on and Whoop+ polls as fast as is
  // responsible. The published ceiling is 100 requests/minute and 10,000/day,
  // so 2 seconds costs 30/minute — under a third of the per-minute budget.
  // It is capped in time rather than left running: 20 minutes of live mode is
  // 600 calls, and the baseline timer is suspended meanwhile so the two never
  // stack. Note this lowers LATENCY, not resolution: WHOOP still publishes in
  // batches, so live mode means a new batch shows up within ~2s of landing.
  const HR_LIVE_SECONDS = 2;
  const HR_LIVE_MAX_MINUTES = 20;
  let hrLiveTimer = null;
  let hrLiveUntil = 0;

  function hrLiveActive() {
    return !!hrLiveTimer && Date.now() < hrLiveUntil;
  }

  function stopHrLive() {
    if (hrLiveTimer) clearInterval(hrLiveTimer);
    hrLiveTimer = null;
    hrLiveUntil = 0;
    startHrTimer();
    pushHeartRate();
  }

  function startHrLive() {
    if (hrTimer) clearInterval(hrTimer);
    hrTimer = null;
    if (hrLiveTimer) clearInterval(hrLiveTimer);
    hrLiveUntil = Date.now() + HR_LIVE_MAX_MINUTES * 60000;
    hrLiveTimer = setInterval(() => {
      if (Date.now() >= hrLiveUntil) {
        stopHrLive();
        return;
      }
      sampleHeartRate().catch((err) => console.error('HR live sample failed:', err));
    }, HR_LIVE_SECONDS * 1000);
    sampleHeartRate().catch((err) => console.error('HR live sample failed:', err));
  }

  async function pushHeartRate() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      mainWindow.webContents.send('whoop:heartRate', await buildHrPayload());
    } catch (err) {
      console.error('Heart-rate push failed:', err);
    }
  }

  // Refit the personal energy -> bpm model occasionally; history barely
  // moves within a session, so hourly is ample.
  const HR_REFIT_MINS = 60;
  let hrRefitAt = 0;

  async function refitHrModel(force = false) {
    if (!hrStore) return null;
    if (!force && Date.now() - hrRefitAt < HR_REFIT_MINS * 60000) return hrStore.getModel();
    try {
      const hrMod = await loadHrMonitor();
      const historyMod = await loadHistory();
      const data = await historyMod.getHistory({ days: 0 });
      const pts = hrMod.calibrationPoints({
        workouts: data.workouts || [],
        cycles: data.cycles || [],
      });
      const model = hrMod.fitEnergyModel(pts);
      hrRefitAt = Date.now();
      if (model) hrStore.setModel(model);
      return model;
    } catch (err) {
      console.error('Heart-rate model refit failed:', err);
      return hrStore.getModel();
    }
  }

  async function sampleHeartRate() {
    if (!hrStore) return;
    try {
      const client = await loadWhoopClient();
      const ctx = await client.getAuthedContext();
      // fetchRecordsPage always sends start/end, so both must be real ISO
      // strings. 36 hours back reliably covers the in-progress cycle.
      const end = new Date().toISOString();
      const start = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
      const page = await client.fetchRecordsPage('cycle', { start, end, limit: 1 }, ctx);
      const raw = (page && page.records) || [];
      if (!raw.length) return;
      const cycle = client.normalizeCycle(raw[0]);
      await refitHrModel();
      // Carry the API's own ids/timestamps plus cumulative energy through.
      const result = await hrStore.record({
        cycle: {
          id: raw[0].id,
          start: raw[0].start,
          kilojoules: cycle.kilojoules,
          avgHr: cycle.avgHr,
          maxHr: cycle.maxHr,
        },
      });
      // While live, push every poll so the card's clock and countdown stay
      // honest even when WHOOP returned no new data.
      if ((result.added || hrLiveActive()) && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('whoop:heartRate', await buildHrPayload());
      }
    } catch (err) {
      // Sampling is best-effort; a transient failure must not kill the timer.
      console.error('Heart-rate sample failed:', err);
    }
  }

  function startHrTimer() {
    if (hrTimer) clearInterval(hrTimer);
    hrTimer = setInterval(() => {
      sampleHeartRate().catch((err) => console.error('HR sampler failed:', err));
    }, HR_SAMPLE_SECONDS * 1000);
    refitHrModel(true).catch(() => {});
    sampleHeartRate().catch((err) => console.error('HR sampler failed:', err));
  }

  async function buildHrPayload() {
    if (!hrStore) return { error: 'Heart-rate monitor not initialized yet' };
    const historyMod = await loadHistory();
    const data = await historyMod.getHistory({ days: 2 });
    const cycles = data.cycles || [];
    const workouts = data.workouts || [];
    const cycle = cycles.length ? cycles[0] : null;
    const live = hrLiveActive();
    return {
      ...hrStore.getSeries({ cycle, workouts }),
      sampleEverySeconds: live ? HR_LIVE_SECONDS : HR_SAMPLE_SECONDS,
      live,
      liveSecondsLeft: live ? Math.max(0, Math.round((hrLiveUntil - Date.now()) / 1000)) : 0,
      liveMaxMinutes: HR_LIVE_MAX_MINUTES,
    };
  }

  function startAutoRefreshTimer() {
    if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    const mins = Math.max(1, Number(settings.autoRefreshMins) || DEFAULT_SETTINGS.autoRefreshMins);
    autoRefreshTimer = setInterval(() => {
      doRefresh().catch((err) => console.error('Auto-refresh failed:', err));
    }, mins * 60000);
  }

  // -----------------------------------------------------------------------
  // Notifications
  // -----------------------------------------------------------------------
  function clampHour(h) {
    const n = Number(h);
    if (!Number.isFinite(n)) return DEFAULT_SETTINGS.morningHour;
    return Math.min(23, Math.max(0, Math.round(n)));
  }

  function scheduleMorningNotification() {
    if (morningTimer) {
      clearTimeout(morningTimer);
      morningTimer = null;
    }
    if (!settings.notificationsEnabled) return;

    const now = new Date();
    const hour = clampHour(settings.morningHour);
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    const delayMs = next.getTime() - now.getTime();

    morningTimer = setTimeout(() => {
      sendMorningNotification()
        .catch((err) => console.error('Morning notification failed:', err))
        .finally(() => scheduleMorningNotification());
    }, delayMs);
  }

  async function sendMorningNotification() {
    if (!settings.notificationsEnabled) return;
    if (!Notification.isSupported()) return;

    const analyticsMod = await loadAnalytics();
    const dashboard = await getDashboardWithFallback();
    if (!dashboard || dashboard.error) return;

    const recovery = Array.isArray(dashboard.recovery) ? dashboard.recovery : [];
    const sleep = Array.isArray(dashboard.sleep) ? dashboard.sleep : [];
    const rec = recovery.find((r) => r.score != null) || null;
    const sleepRec = sleep.find((s) => s.performancePct != null) || null;
    const score = rec ? rec.score : null;
    const target = analyticsMod.strainTargetFor(score);

    const title = score != null ? `Recovery ${Math.round(score)}% — ${target.label || 'Maintain'}` : 'Whoop+ morning summary';
    const bodyParts = [];
    if (rec && rec.hrv != null) bodyParts.push(`HRV ${Math.round(rec.hrv)}ms`);
    if (rec && rec.rhr != null) bodyParts.push(`RHR ${Math.round(rec.rhr)}bpm`);
    if (sleepRec && sleepRec.performancePct != null) bodyParts.push(`Sleep ${Math.round(sleepRec.performancePct)}%`);
    if (target.low != null && target.high != null) bodyParts.push(`Strain target ${target.low}-${target.high}`);

    new Notification({ title, body: bodyParts.join(' · ') || 'Open Whoop+ for today’s details.' }).show();
  }

  async function checkAnomalyAndNotify() {
    try {
      const history = await loadHistory();
      const analyticsMod = await loadAnalytics();
      const full = await history.getHistory({ days: 0 });
      const result = analyticsMod.anomaly({ recovery: full.recovery, sleep: full.sleep }, { days: 28 });

      const wasFlagged = !!settings.lastAnomalyFlagged;
      if (result.flagged && !wasFlagged && settings.notificationsEnabled && Notification.isSupported()) {
        new Notification({
          title: 'Whoop+ anomaly detected',
          body: result.reasons.length ? result.reasons.join(' ') : 'Your recovery metrics look unusual today.',
        }).show();
      }

      if (result.flagged !== wasFlagged) {
        settings.lastAnomalyFlagged = result.flagged;
        await saveSettingsAtomic();
      }
    } catch (err) {
      console.error('Anomaly check failed:', err);
    }
  }

  // -----------------------------------------------------------------------
  // Analytics / backfill-status (shared by IPC handlers and --ipc-check)
  // -----------------------------------------------------------------------
  async function fetchAnalytics(days = 30) {
    const historyMod = await loadHistory();
    const analyticsMod = await loadAnalytics();

    let data = await historyMod.getHistory({ days: 0 });
    const isEmpty = !data.recovery.length && !data.sleep.length && !data.cycles.length && !data.workouts.length;
    if (isEmpty) {
      const dashboard = await getDashboardWithFallback();
      if (dashboard && !dashboard.error) {
        data = {
          profile: dashboard.profile,
          recovery: dashboard.recovery || [],
          sleep: dashboard.sleep || [],
          cycles: dashboard.cycles || [],
          workouts: dashboard.workouts || [],
        };
      }
    }

    const { recovery, sleep, cycles } = data;

    const deviations = {
      hrv: analyticsMod.deviation(recovery, 'hrv', { days }),
      rhr: analyticsMod.deviation(recovery, 'rhr', { days }),
      spo2: analyticsMod.deviation(recovery, 'spo2', { days }),
      skinTempC: analyticsMod.deviation(recovery, 'skinTempC', { days }),
      respiratoryRateBpm: analyticsMod.deviation(sleep, 'respiratoryRateBpm', { days }),
    };
    const newestScore = recovery.find((r) => r.score != null)?.score ?? null;

    return {
      deviations,
      hrvBaseline: analyticsMod.rollingBaseline(recovery, 'hrv', { days: 90 }),
      rhrBaseline: analyticsMod.rollingBaseline(recovery, 'rhr', { days: 90 }),
      strainTarget: analyticsMod.strainTargetFor(newestScore),
      acwr: analyticsMod.acwr(cycles),
      sleepDebt: analyticsMod.sleepDebtSeries(sleep),
      anomaly: analyticsMod.anomaly({ recovery, sleep }, { days }),
      compare7v7: analyticsMod.periodCompare({ recovery, sleep, cycles }, { aDays: 7, bDays: 7 }),
    };
  }

  async function fetchBackfillStatus() {
    const historyMod = await loadHistory();
    const status = await historyMod.getStatus();
    return { ...status, running: backfillRunning };
  }

  async function buildCoachContext() {
    const historyMod = await loadHistory();
    const analyticsMod = await loadAnalytics();

    const contextMod = await import('./src/coach-context.mjs');

    const full = await historyMod.getHistory({ days: 0 });
    const recent = await historyMod.getHistory({ days: 14 });

    let strap = null;
    if (hrStore) {
      const series = hrStore.getSeries({});
      const recent = series.measured && series.measured.recent ? series.measured.recent : [];
      const bpms = recent.map((r) => r.bpm);
      const latestAt = series.measured && series.measured.latestAt;
      strap = {
        streamingNow: !!(latestAt && Date.now() - new Date(latestAt).getTime() < 2 * 60000),
        latestMeasuredBpm: series.measured ? series.measured.latestBpm : null,
        latestMeasuredAt: latestAt || null,
        last20MinAvgBpm: bpms.length ? Math.round(bpms.reduce((a, b) => a + b, 0) / bpms.length) : null,
        last20MinMaxBpm: bpms.length ? Math.max(...bpms) : null,
        measuredReadingsToday: series.measured ? series.measured.count : 0,
        lastWorkoutSession: series.lastSession || null,
        battery: series.strapInfo ? series.strapInfo.battery ?? null : null,
      };
    }
    return contextMod.buildCoachContext({ full, recent, analytics: analyticsMod, strap });
  }

  // -----------------------------------------------------------------------
  // IPC handlers
  // -----------------------------------------------------------------------
  ipcMain.handle('whoop:getDashboard', async () => {
    return getDashboardWithFallback();
  });

  ipcMain.handle('whoop:refresh', async () => {
    try {
      return await doRefresh();
    } catch (err) {
      return { error: String(err) };
    }
  });

  ipcMain.handle('whoop:getHistory', async (event, opts) => {
    try {
      const historyMod = await loadHistory();
      return await historyMod.getHistory(opts || {});
    } catch (err) {
      return { error: String(err) };
    }
  });

  ipcMain.handle('whoop:getBackfillStatus', async () => {
    try {
      return await fetchBackfillStatus();
    } catch (err) {
      return { error: String(err) };
    }
  });

  ipcMain.handle('whoop:getAnalytics', async (event, opts) => {
    try {
      return await fetchAnalytics((opts && opts.days) || 30);
    } catch (err) {
      return { error: String(err) };
    }
  });

  ipcMain.handle('whoop:coachStatus', async () => {
    try {
      const coach = await loadCoach();
      return await coach.coachStatus({ apiKey: settings.anthropicApiKey });
    } catch (err) {
      return { error: String(err) };
    }
  });

  ipcMain.handle('whoop:askCoach', async (event, { question, history: chatHistory } = {}) => {
    try {
      const coach = await loadCoach();
      const context = await buildCoachContext();
      return await coach.askCoach({
        question,
        history: chatHistory,
        context,
        apiKey: settings.anthropicApiKey,
      });
    } catch (err) {
      return { error: String(err) };
    }
  });

  ipcMain.handle('whoop:exportCsv', async (event, { kind } = {}) => {
    try {
      const exportMod = await loadExport();
      const outDir = path.join(os.homedir(), 'Downloads');
      let records;
      if (kind === 'heartrate') {
        if (!hrStore) throw new Error('Heart-rate monitor not initialized yet');
        records = hrStore.listMeasured();
      } else {
        const historyMod = await loadHistory();
        const data = await historyMod.getHistory({ days: 0 });
        records = data[kind];
      }
      if (!records) throw new Error(`Unknown export kind: "${kind}"`);
      return await exportMod.exportCsv({ kind, records, outDir });
    } catch (err) {
      return { error: String(err) };
    }
  });

  ipcMain.handle('whoop:getHeartRate', async () => {
    try {
      return await buildHrPayload();
    } catch (err) {
      return { error: String(err) };
    }
  });

  ipcMain.handle('whoop:addStrapSession', async (event, session) => {
    try {
      if (!hrStore) return { error: 'Heart-rate monitor not initialized yet' };
      return await hrStore.addSession(session || null);
    } catch (err) {
      return { error: String(err) };
    }
  });

  ipcMain.handle('whoop:setStrapInfo', async (event, info) => {
    try {
      if (!hrStore) return { error: 'Heart-rate monitor not initialized yet' };
      return await hrStore.setStrapInfo(info || null);
    } catch (err) {
      return { error: String(err) };
    }
  });

  ipcMain.handle('whoop:recordStrapSamples', async (event, batch) => {
    try {
      if (!hrStore) return { error: 'Heart-rate monitor not initialized yet' };
      return await hrStore.recordMeasuredBatch(Array.isArray(batch) ? batch : []);
    } catch (err) {
      return { error: String(err) };
    }
  });

  ipcMain.handle('whoop:setLiveHr', async (event, { on } = {}) => {
    try {
      if (on) startHrLive();
      else stopHrLive();
      return await buildHrPayload();
    } catch (err) {
      return { error: String(err) };
    }
  });

  ipcMain.handle('whoop:getSettings', async () => {
    try {
      return { ...settings };
    } catch (err) {
      return { error: String(err) };
    }
  });

  ipcMain.handle('whoop:setSettings', async (event, patch) => {
    try {
      settings = { ...settings, ...(patch || {}) };
      await saveSettingsAtomic();
      if (patch) {
        if ('launchAtLogin' in patch) applyLoginItemSettings();
        if ('morningHour' in patch || 'notificationsEnabled' in patch) scheduleMorningNotification();
        if ('autoRefreshMins' in patch) startAutoRefreshTimer();
      }
      return { ...settings };
    } catch (err) {
      return { error: String(err) };
    }
  });

  // -----------------------------------------------------------------------
  // --ipc-check: exercises the main-process IPC handler logic directly
  // (no renderer needed), for verifying this side of the IPC contract
  // independently of renderer state. Prints one "<name>: ok" or
  // "<name>: error: <message>" line per check.
  // -----------------------------------------------------------------------
  async function runIpcCheck() {
    const results = [];
    async function check(name, fn) {
      try {
        await fn();
        results.push(`${name}: ok`);
      } catch (err) {
        results.push(`${name}: error: ${err && err.message ? err.message : err}`);
      }
    }

    await check('getAnalytics', async () => {
      const result = await fetchAnalytics(30);
      if (result && result.error) throw new Error(result.error);
      if (!result || !result.deviations || !result.acwr) throw new Error('unexpected shape');
    });

    await check('getBackfillStatus', async () => {
      const result = await fetchBackfillStatus();
      if (result && result.error) throw new Error(result.error);
      if (typeof result.running !== 'boolean') throw new Error('missing running flag');
    });

    await check('exportCsv', async () => {
      const exportMod = await loadExport();
      const historyMod = await loadHistory();
      const data = await historyMod.getHistory({ days: 0 });
      const tmpDir = path.join(os.tmpdir(), `whoop-desk-ipc-check-export-${process.pid}-${Date.now()}`);
      const result = await exportMod.exportCsv({ kind: 'recovery', records: data.recovery, outDir: tmpDir });
      if (!result || !result.path) throw new Error('exportCsv returned no path');
    });

    await check('coachStatus', async () => {
      const coach = await loadCoach();
      const status = await coach.coachStatus();
      if (!status || typeof status.available !== 'boolean') throw new Error('unexpected shape');
    });

    for (const line of results) console.log(line);
  }

  // -----------------------------------------------------------------------
  // Smoke mode (screenshot + console-error capture)
  // -----------------------------------------------------------------------
  function runSmokeMode(win) {
    const consoleErrors = [];

    win.webContents.on('console-message', (_event, level, message) => {
      // level 2 = warning, 3 = error (Electron's console-message levels)
      if (level >= 2) {
        consoleErrors.push(message);
      }
    });

    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      consoleErrors.push(`did-fail-load: ${errorCode} ${errorDescription} (${validatedURL})`);
    });

    const hardTimeout = setTimeout(() => {
      console.log('SMOKE_ERRORS:');
      console.log(consoleErrors.length ? consoleErrors.join('\n') : 'none');
      console.log('SMOKE_TIMEOUT: hard 20s timeout hit');
      app.exit(1);
    }, 20000);

    // `--view=sleep|strain|health|trends` shoots a section other than the
    // default Overview; the smoke image is always written to smoke.png.
    const viewArg = process.argv.find((a) => a.startsWith('--view='));
    const smokeView = viewArg ? viewArg.slice('--view='.length) : null;
    // `--scroll=<px|bottom>` scrolls the content column before the shot, so
    // cards below the fold can be verified on a screen-sized window.
    const scrollArg = process.argv.find((a) => a.startsWith('--scroll='));
    const smokeScroll = scrollArg ? scrollArg.slice('--scroll='.length) : null;

    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        if (smokeView && /^[a-z]+$/.test(smokeView)) {
          try {
            await win.webContents.executeJavaScript(
              `(() => { const b = document.getElementById('nav-${smokeView}'); if (b) b.click(); })()`
            );
            await new Promise((resolve) => setTimeout(resolve, 700));
          } catch (err) {
            consoleErrors.push(`view switch failed: ${err}`);
          }
        }
        if (smokeScroll && /^(bottom|\d+)$/.test(smokeScroll)) {
          try {
            await win.webContents.executeJavaScript(
              `(() => { const c = document.getElementById('content'); if (c) c.scrollTop = ${
                smokeScroll === 'bottom' ? 'c.scrollHeight' : smokeScroll
              }; })()`
            );
            await new Promise((resolve) => setTimeout(resolve, 400));
          } catch (err) {
            consoleErrors.push(`scroll failed: ${err}`);
          }
        }
        try {
          const image = await win.webContents.capturePage();
          // Use the invocation cwd, not __dirname: in a packaged app,
          // __dirname resolves inside the (read-only, install-location)
          // app bundle, which isn't where a caller running --smoke wants
          // the debug screenshot to land.
          const outPath = path.join(process.cwd(), 'smoke.png');
          fs.writeFileSync(outPath, image.toPNG());
        } catch (err) {
          consoleErrors.push(`capturePage failed: ${err}`);
        }

        console.log('SMOKE_ERRORS:');
        console.log(consoleErrors.length ? consoleErrors.join('\n') : 'none');

        clearTimeout(hardTimeout);
        app.exit(0);
      }, 3000);
    });
  }

  // -----------------------------------------------------------------------
  // App lifecycle
  // -----------------------------------------------------------------------
  app.whenReady().then(async () => {
    await loadSettings();

    const dataDir = app.getPath('userData');
    const historyMod = await loadHistory();
    historyMod.initHistory({ dataDir });

    const hrMod = await loadHrMonitor();
    hrStore = await hrMod.initHrMonitor({ dataDir });

    if (isIpcCheck) {
      await runIpcCheck();
      app.exit(0);
      return;
    }

    setDockIcon();
    applyLoginItemSettings();
    createWindow();
    createTray();
    startAutoRefreshTimer();
    startHrTimer();
    startStrapRetryTimer();
    setTimeout(nudgeStrapConnect, 8000); // first silent attempt after the UI settles
    scheduleMorningNotification();

    powerMonitor.on('resume', () => {
      doRefresh().catch((err) => console.error('Refresh on resume failed:', err));
      sampleHeartRate().catch((err) => console.error('HR sample on resume failed:', err));
      setTimeout(nudgeStrapConnect, 5000);
    });

    app.on('activate', () => {
      showAndFocusWindow();
    });

    // Init: if the local history store isn't fully backfilled yet, run the
    // (resumable) backfill in the background, forwarding progress events to
    // the renderer, then push a fresh dashboard once it completes.
    historyMod
      .getStatus()
      .then((status) => {
        if (status.backfillComplete) return;
        backfillRunning = true;
        historyMod
          .backfillAll({ onProgress: (progress) => pushBackfillProgress(progress) })
          .catch((err) => console.error('Background backfill failed:', err))
          .finally(() => {
            backfillRunning = false;
            doRefresh().catch((err) => console.error('Post-backfill refresh failed:', err));
          });
      })
      .catch((err) => console.error('Failed to read backfill status:', err));
  });

  app.on('window-all-closed', () => {
    // Standard window close quits the app; the tray is a menu-bar readout
    // alongside the dock app, not a background-only mode.
    app.quit();
  });
}
