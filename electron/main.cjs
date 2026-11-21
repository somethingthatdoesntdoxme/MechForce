// Desktop shell for Windows, Steam Deck and Linux.
const { app, BrowserWindow, ipcMain, Menu, powerMonitor, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { detect } = require('./handheld.cjs');
const device = detect();
const { handheld, gamescope } = device;
const isDeck = !!(handheld && handheld.family === 'deck');
// handhelds, SteamOS game mode and Bazzite-style sessions all want the couch setup:
// fullscreen, sized for a small screen held close
const couch = !!(handheld || gamescope);

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder');
}
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
if (couch) {
  // integrated GPUs: rasterise the UI on the GPU and skip a copy on the way to the screen
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
}

const root = path.join(__dirname, '..');
const webRoot = path.join(root, 'dist', 'web');
let win = null;
let host = null;
let stopBeacons = null;
const seen = new Map();

function serverMod() { return require(path.join(root, 'dist', 'server.cjs')); }

function createWindow() {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 800, minHeight: 500,
    backgroundColor: '#0b0f13', show: false, autoHideMenuBar: true,
    fullscreen: couch || process.argv.includes('--fullscreen'),
    title: 'MechForce',
    icon: path.join(root, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
  });
  win.once('ready-to-show', () => win.show());
  // High-res handheld screens (the Go S and Ally at 1080p/1200p, the Legion Go at 1600p) are
  // tiny at 1:1: lay the UI out as if the screen were 1280x800 so text stays readable. If the OS
  // already scales the desktop (Windows at 150%), its logical size is small and this stays 1.
  if (handheld) win.webContents.on('did-finish-load', () => {
    const { width, height } = screen.getPrimaryDisplay().size;
    const z = Math.max(1, Math.min(width / 1280, height / 800));
    win.webContents.setZoomFactor(Math.round(z * 100) / 100);
  });
  win.loadFile(path.join(webRoot, 'index.html'));
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F11' || (input.alt && input.key === 'Enter'))) { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
  });
}

ipcMain.handle('host:start', async () => {
  if (host) return { port: host.port, addresses: host.addresses };
  const { startServer } = serverMod();
  let lastErr = null;
  for (const port of [7373, 7375, 7377]) {
    try {
      host = await startServer({ port, webRoot, name: os.hostname() + (handheld ? ` (${handheld.name})` : '') });
      return { port: host.port, addresses: host.addresses };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
});
ipcMain.handle('host:stop', async () => { if (host) { await host.close(); host = null; } });
ipcMain.handle('discover', async () => {
  if (!stopBeacons) {
    const { listenBeacons } = serverMod();
    stopBeacons = listenBeacons((h) => seen.set(h.address + ':' + h.port, { ...h, at: Date.now() }));
  }
  const now = Date.now();
  return [...seen.values()].filter((h) => now - h.at < 5000).map(({ at, ...h }) => h);
});
ipcMain.on('quit', () => app.quit());
ipcMain.on('device', (e) => { let onBattery = false; try { onBattery = powerMonitor.isOnBatteryPower(); } catch {} e.returnValue = { ...device, onBattery }; });
ipcMain.on('fullscreen', () => win && win.setFullScreen(!win.isFullScreen()));

app.whenReady().then(() => {
  createWindow();
  const power = (b) => win && !win.isDestroyed() && win.webContents.send('power', b);
  powerMonitor.on('on-battery', () => power(true));
  powerMonitor.on('on-ac', () => power(false));
});
app.on('window-all-closed', async () => { if (host) await host.close(); app.quit(); });
