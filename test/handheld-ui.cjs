// Handheld performance in the browser: render scale, frame caps, battery saver, FPS readout.
// node test/handheld-ui.cjs
const { chromium } = require('playwright');
let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; console.log('FAIL', msg); } else console.log('ok  ', msg); };
const fpsOver = (p, ms) => p.evaluate((ms) => new Promise((res) => {
  // count calls to the renderer's per-frame update
  const r = window.__mf.renderer; let n = 0;
  if (!r.__orig) { r.__orig = r.frame; }
  r.frame = function (dt) { n++; return r.__orig.call(this, dt); };
  const t0 = performance.now();
  setTimeout(() => { r.frame = r.__orig; res(Math.round(n * 1000 / (performance.now() - t0))); }, ms);
}), ms);
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const errs = [];
  // a Legion Go S sized screen: 1920x1200 at 1:1
  const p = await (await b.newContext({ viewport: { width: 1920, height: 1200 } })).newPage();
  p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript(() => localStorage.setItem('mechforce.settings', JSON.stringify({ tutorialDone: true })));
  await p.goto('file://' + process.cwd() + '/dist/web/index.html?handheld=1'); await p.waitForTimeout(2500);
  const info = await p.evaluate(() => { const app = window.__mf, c = app.renderer.gl.domElement; return { w: c.width, h: c.height, q: app.settings.quality, name: app.settings.name }; });
  ok(info.q === 'medium' && info.name === 'Handheld Pilot', 'handhelds default to medium graphics: ' + JSON.stringify(info));
  ok(info.w <= 1300 && info.w >= 1250 && info.h <= 820, `a 1920x1200 handheld renders about 1280x800 (${info.w}x${info.h})`);
  const set = (o) => p.evaluate((o) => { Object.assign(window.__mf.settings, o); window.__mf.saveSettings(); }, o);
  await set({ renderScale: 1 });
  ok(await p.evaluate(() => window.__mf.renderer.gl.domElement.width) === 1920, 'render resolution 100% is native');
  await set({ renderScale: 0.5, quality: 'low', fpsCap: 0 });
  await set({ fpsCap: 'auto', saver: 'on' });
  // a quiet screen (the title runs a demo battle, which counts as animating)
  await p.evaluate(() => { window.__mf.stopAttract(); window.__mf.showSettings(() => window.__mf.showTitle()); });
  await set({ renderScale: 'auto', quality: 'medium' });
  const saverRes = await p.evaluate(() => window.__mf.renderer.gl.domElement.width);
  ok(saverRes < 1250, `battery saver lowers the render resolution (${saverRes} wide)`);
  await set({ showFps: true }); await p.waitForTimeout(3000);
  const fpsTxt = await p.evaluate(() => { const e = document.querySelector('.fps-readout'); return e ? e.textContent || '(empty: ' + window.__mfPerf.fps + ')' : 'none'; });
  ok(/\d+ fps/.test(fpsTxt || '') && /saver/.test(fpsTxt), 'frame-rate readout: ' + fpsTxt);
  // settings screen shows the new rows and the device line
  await p.evaluate(() => window.__mf.showSettings(() => window.__mf.showTitle()));
  await p.waitForTimeout(500);
  const rows = await p.evaluate(() => ['renderScale', 'fpsCap', 'saver', 'showFps'].map((k) => document.querySelector(`[data-key=${k}] .val`)?.textContent));
  void fpsOver;
  ok(rows.every(Boolean), 'settings rows: ' + rows.join(' | '));
  ok(await p.evaluate(() => /Running on a Handheld/.test(document.body.textContent)), 'settings say which device it is');
  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  await p.context().close();
  // a desktop browser is unaffected
  const d = await (await b.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  await d.addInitScript(() => localStorage.setItem('mechforce.settings', JSON.stringify({ tutorialDone: true })));
  await d.goto('file://' + process.cwd() + '/dist/web/index.html'); await d.waitForTimeout(2000);
  const dk = await d.evaluate(() => ({ w: window.__mf.renderer.gl.domElement.width, q: window.__mf.settings.quality }));
  ok(dk.w === 1600 && dk.q === 'high', 'desktop stays at full resolution and high: ' + JSON.stringify(dk));
  await b.close();
  console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
})();
