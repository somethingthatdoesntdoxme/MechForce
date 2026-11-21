// Frame pacing, render resolution and battery saving, mostly for handhelds (Steam Deck,
// Legion Go S, ROG Ally...). The game is turn-based, so most of the time nothing needs
// 120 frames a second: frames are capped to an even divisor of the screen's refresh rate,
// drop further while nobody is touching anything, and high-res handheld screens render at
// about 1280x800 and are scaled up.
import { native, handheld } from './platform.js';

export const perf = {
  refresh: 60,          // measured display refresh rate
  onBattery: !!(native && native.device && native.device.onBattery),
  lastInput: 0,
  settings: { fpsCap: 'auto', renderScale: 'auto', saver: 'auto' },
  fps: 0,
};

// ---- refresh rate: the fast end of recent requestAnimationFrame intervals. Slow frames
// (a busy GPU) and skipped frames stretch intervals, never shorten them, so the 10th
// percentile tracks the screen itself.
const iv = [];
export function sampleFrame(dtMs) {
  if (dtMs <= 2 || dtMs > 100) return;
  iv.push(dtMs); if (iv.length > 60) iv.shift();
  if (iv.length >= 20 && iv.length % 10 === 0) {
    const s = iv.slice().sort((a, b) => a - b), fast = s[Math.floor(s.length * 0.1)];
    const hz = 1000 / fast;
    perf.refresh = [30, 40, 45, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 240].reduce((b, r) => (Math.abs(r - hz) < Math.abs(b - hz) ? r : b), 60);
  }
}

// battery: Electron's power monitor, or the browser battery API
if (native && native.onPower) native.onPower((b) => { perf.onBattery = b; perf.changed && perf.changed(); });
else if (typeof navigator !== 'undefined' && navigator.getBattery) {
  navigator.getBattery().then((bat) => {
    const upd = () => { perf.onBattery = !bat.charging; perf.changed && perf.changed(); };
    bat.addEventListener('chargingchange', upd); upd();
  }).catch(() => {});
}

export const saverOn = () => {
  const s = perf.settings.saver;
  return s === 'on' || (s === 'auto' && !!handheld && perf.onBattery);
};

// The frame cap: the explicit setting, or on handhelds 60 (40-ish on battery), each turned
// into a whole divisor of the refresh rate so frames are evenly spaced (40 on a 120 Hz
// screen, 45 on a 90 Hz Deck OLED, 30 on a 60 Hz panel).
export function targetFps() {
  const c = perf.settings.fpsCap;
  if (c === 0) return 0;
  if (c !== 'auto') return c;
  if (!handheld && !saverOn()) return 0;
  return saverOn() ? 40 : 60;
}
// The frame interval to aim for. Snapped to a whole number of screen refreshes so frames
// stay evenly spaced (40 on a 120 Hz screen, 45 on a 90 Hz Deck OLED, 30 on 60 Hz).
export function frameInterval(idle) {
  let t = targetFps();
  if (idle && (saverOn() || handheld)) t = Math.min(t || perf.refresh, saverOn() ? 20 : 30);
  if (!t) return 0;
  const n = Math.max(1, Math.ceil(perf.refresh / t - 0.05)); // never faster than the cap
  return (1000 / perf.refresh) * n;
}
// whether to draw on this animation frame: due once the interval has passed, give or take
// half a refresh so vsync jitter doesn't skip a beat
let lastDraw = 0;
export function frameDue(now, idle) {
  const want = frameInterval(idle);
  if (now < lastDraw - 1000) lastDraw = 0; // clock went backwards (a new timeline)
  if (!want || now - lastDraw >= want - 500 / perf.refresh) { lastDraw = want && now - lastDraw < want * 2 ? lastDraw + want : now; return true; }
  return false;
}

// Render resolution as a fraction of the screen's own. Auto: about 1280x800 worth of pixels
// on high-res handhelds (less on battery), full resolution everywhere else.
export function renderScale(cssW, cssH, dpr) {
  const r = perf.settings.renderScale;
  if (r !== 'auto') return r;
  if (!handheld) return saverOn() ? 0.85 : 1;
  const px = cssW * cssH * dpr * dpr, want = 1280 * 800 * (saverOn() ? 0.72 : 1);
  return Math.max(0.5, Math.min(1, Math.sqrt(want / px)));
}

export function noteInput() { perf.lastInput = performance.now(); }
export const idleFor = () => performance.now() - perf.lastInput;
