const { contextBridge, ipcRenderer } = require('electron');

// handheld profile, gamescope session and battery state, worked out by the main process
let device = { handheld: null, gamescope: false, steamos: false, onBattery: false };
try { device = ipcRenderer.sendSync('device') || device; } catch {}
const powerListeners = [];
ipcRenderer.on('power', (_e, onBattery) => { device.onBattery = onBattery; for (const f of powerListeners) f(onBattery); });

contextBridge.exposeInMainWorld('mfNative', {
  platform: process.platform,
  isDeck: !!(device.handheld && device.handheld.family === 'deck'),
  device,
  onPower: (f) => powerListeners.push(f),
  hostStart: () => ipcRenderer.invoke('host:start'),
  hostStop: () => ipcRenderer.invoke('host:stop'),
  discover: () => ipcRenderer.invoke('discover'),
  quit: () => ipcRenderer.send('quit'),
  toggleFullscreen: () => ipcRenderer.send('fullscreen'),
});
