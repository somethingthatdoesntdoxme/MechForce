// Close-up of mechs (player's turn, nothing moving) to check mech lighting and effects.
// node test/look-mechs.cjs [theme]   (QUALITY, SHOT as for look.cjs)
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const OUT = process.env.SHOT || path.join(__dirname, '..', 'shots'); require('fs').mkdirSync(OUT, { recursive: true });
  const theme = process.argv[2] || 'temperate';
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await (await b.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  await p.addInitScript((quality) => localStorage.setItem('mechforce.settings', JSON.stringify({ quality, speed: 1 })), process.env.QUALITY || 'high');
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('file://' + path.join(__dirname, '..', 'dist/web/index.html')); await p.waitForTimeout(2000);
  await p.evaluate(() => { const a = window.__mf; a.stopAttract && a.stopAttract(); a.startLocal('skirmish'); });
  await p.waitForTimeout(300);
  await p.evaluate((theme) => { window.__mf.session.send({ t: 'settings', settings: { mapSize: 'S', seed: 'mechs-' + theme, theme } }); }, theme);
  await p.waitForTimeout(200); await p.evaluate(() => window.__mf.session.send({ t: 'start' }));
  await p.waitForTimeout(1500); await p.keyboard.press('Enter'); await p.waitForTimeout(1500);
  // frame the first side's lance up close, then set off effects on it
  await p.evaluate(() => {
    const r = window.__mf.renderer, vs = [...r.mechs.values()].filter((v) => v.state.side === 0);
    const c = vs[0].model.root.position.clone(); for (const v of vs.slice(1)) c.add(v.model.root.position); c.multiplyScalar(1 / vs.length);
    // the battle camera reframes on turn changes, so hold the shot for a moment
    const hold = () => { r.cam.want.copy(c); r.cam.wantDist = 9.5; r.cam.userDist = null; r.cam.wantPitch = 0.78; };
    hold(); window.__hold = setInterval(hold, 50);
  });
  await p.waitForTimeout(2500);
  await p.screenshot({ path: path.join(OUT, `mechs-${theme}.png`) });
  await p.evaluate(() => {
    const r = window.__mf.renderer, vs = [...r.mechs.values()].filter((v) => v.state.side === 0);
    vs[0].damaged = true; vs[0].armorFrac = 0.15; // pretend it's badly hurt for the smoke and sparks
    for (const v of vs) { r.muzzleFlash(r.muzzleWorld(v, 2), '#ffc44a', 1.1); r.dust(v.model.root.position, 6, 0.3); }
    // the software renderer used for screenshots is slow: step time by hand and freeze the
    // main loop so the effects are still there when the screenshot is taken
    r.frame(0.03); r.frame(0.03);
    r.__frame = r.frame; r.frame = () => {};
  });
  await p.screenshot({ path: path.join(OUT, `mechs-${theme}-fx.png`) });
  await p.evaluate(() => { const r = window.__mf.renderer; r.frame = r.__frame; for (let i = 0; i < 40; i++) r.frame(0.05); r.frame = () => {}; });
  await p.screenshot({ path: path.join(OUT, `mechs-${theme}-smoke.png`) });
  console.log('errors', errs.length ? errs.slice(0, 3) : 'none');
  await b.close();
})();
