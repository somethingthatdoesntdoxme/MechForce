// Screenshot a few battles across themes and camera distances for eyeballing the graphics.
// node test/look.cjs   (QUALITY=high by default, SHOT=dir, default shots/)
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const OUT = process.env.SHOT || path.join(__dirname, '..', 'shots'); require('fs').mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await (await b.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  await p.addInitScript((quality) => localStorage.setItem('mechforce.settings', JSON.stringify({ quality, speed: 2 })), process.env.QUALITY || 'high');
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('file://' + path.join(__dirname, '..', 'dist/web/index.html')); await p.waitForTimeout(2500);
  await p.screenshot({ path: path.join(OUT, 'look-title.png') });
  const themes = (process.env.THEMES || 'temperate,desert,snow,volcanic,urban').split(',');
  for (const theme of themes) {
    await p.evaluate(() => { const a = window.__mf; a.stopAttract && a.stopAttract(); a.startLocal('skirmish'); });
    await p.waitForTimeout(300);
    await p.evaluate((theme) => { const s = window.__mf.session; s.send({ t: 'settings', settings: { mapSize: 'S', seed: 'look-' + theme, theme } }); s.send({ t: 'slot', side: 0, ctrl: 'ai' }); }, theme);
    await p.waitForTimeout(200); await p.evaluate(() => window.__mf.session.send({ t: 'start' }));
    await p.waitForTimeout(1500); await p.keyboard.press('Enter');
    await p.waitForTimeout(+(process.env.WAIT || 9000));
    await p.screenshot({ path: path.join(OUT, `look-${theme}.png`) });
    // close-up on a mech
    await p.evaluate(() => { const r = window.__mf.renderer; const v = [...r.mechs.values()][0]; if (v) { r.cam.want.copy(v.model.root.position); r.cam.wantDist = 7; r.cam.userDist = null; } });
    await p.waitForTimeout(1500);
    await p.screenshot({ path: path.join(OUT, `look-${theme}-close.png`) });
    await p.evaluate(() => { const a = window.__mf; a.endSession(); a.showTitle(); });
    await p.waitForTimeout(500);
  }
  console.log('errors', errs.length ? errs.slice(0, 3) : 'none');
  await b.close();
})();
