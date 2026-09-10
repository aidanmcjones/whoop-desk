const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const isSmoke = process.argv.includes('--smoke');

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

app.setName('WhoopDesk');

// Single-instance lock.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  let mainWindow = null;

  async function loadWhoopClient() {
    // Imported lazily/dynamically since src/whoop-client.mjs is an ESM
    // module owned by another part of the build and may not exist yet.
    return import('./src/whoop-client.mjs');
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

  async function refreshDashboard() {
    const client = await loadWhoopClient();
    return client.getDashboard({ days: 30 });
  }

  ipcMain.handle('whoop:getDashboard', async () => {
    return getDashboardWithFallback();
  });

  ipcMain.handle('whoop:refresh', async () => {
    try {
      return await refreshDashboard();
    } catch (err) {
      return { error: String(err) };
    }
  });

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

    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

    if (isSmoke) {
      runSmokeMode(mainWindow);
    }
  }

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
        try {
          const image = await win.webContents.capturePage();
          const outPath = path.join(__dirname, 'smoke.png');
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

  app.whenReady().then(() => {
    setDockIcon();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    // Standard window close quits the app; no tray/background complexity.
    app.quit();
  });
}
