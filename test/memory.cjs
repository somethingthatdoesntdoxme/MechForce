// GPU/JS memory across several battles in one session: should level off, not climb.
// node test/memory.cjs [battles]   (QUALITY=low|medium|high, WAIT=ms per battle, SHOT=dir for screenshots)
const { chromium } = require('playwright');
(async () => {
  const N = +(process.argv[2] || 4);
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--js-flags=--expose-gc', '--enable-precise-memory-info'] });
  const p = await (await b.newContext({ viewport: { width: 960, height: 600 } })).newPage();
  await p.addInitScript((quality) => localStorage.setItem('mechforce.settings', JSON.stringify({ quality, speed: 4 })), process.env.QUALITY || 'low');
  const errs = []; p.on('pageerror', (e) => errs.push(e.stack));
  await p.goto('file://' + process.cwd() + '/dist/web/index.html'); await p.waitForTimeout(1500);
  const snap = () => p.evaluate(() => { window.gc && window.gc(); const r = window.__mf.renderer; const m = r.gl.info.memory; return { geo: m.geometries, tex: m.textures, progs: r.gl.info.programs.length, heapMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1), objs: (() => { let n = 0; r.scene.traverse(() => n++); return n; })() }; });
  const rows = [];
  for (let i = 0; i < N; i++) {
    await p.evaluate((i) => { const a = window.__mf; a.stopAttract && a.stopAttract(); a.startLocal('skirmish'); }, i);
    await p.waitForTimeout(300);
    await p.evaluate((i) => { const s = window.__mf.session; const lances = [['Atlas', 'Locust', 'Catapult'], ['Awesome', 'Jenner', 'Hunchback'], ['Marauder', 'Commando', 'Wolverine'], ['Battlemaster', 'Spider', 'Rifleman']];
      s.send({ t: 'settings', settings: { mapSize: 'S', seed: 'mem' + i, theme: ['temperate', 'desert', 'snow', 'volcanic'][i % 4] } }); s.send({ t: 'slot', side: 0, ctrl: 'ai' }); s.send({ t: 'lance', side: 0, lance: lances[i % 4] }); }, i);
    await p.waitForTimeout(200); await p.evaluate(() => window.__mf.session.send({ t: 'start' }));
    await p.waitForTimeout(1200); await p.keyboard.press('Enter'); // past the briefing
    await p.waitForTimeout(+(process.env.WAIT || 6000));
    if (process.env.SHOT) await p.screenshot({ path: require('path').join(process.env.SHOT, 'mem-battle-' + (i + 1) + '.png') });
    await p.evaluate(() => { const a = window.__mf; a.endSession(); a.showTitle(); });
    await p.waitForTimeout(800);
    rows.push(await snap());
    console.log(`after battle ${i + 1}:`, JSON.stringify(rows[i]));
  }
  console.log('errors', errs.length ? errs.slice(0, 3) : 'none');
  await b.close();
})();
