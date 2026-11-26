// VR tabletop mode, end to end, with an emulated Meta Quest 3 (IWER) in headless Chromium:
// the Enter VR button appears in a battle, a WebXR session starts and renders, the right
// controller's laser picks a hex, trigger + A make a real move, the wrist panel shows the
// turn, and leaving VR restores the flat-screen view.
//   node test/vr.cjs        (SHOT=dir for screenshots; default shots/)
const { chromium } = require('playwright');
const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const OUT = process.env.SHOT || path.join(__dirname, '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };

(async () => {
  // the emulator, bundled to run before the page's own scripts
  const emu = esbuild.buildSync({
    stdin: { contents: "import { XRDevice, metaQuest3 } from 'iwer'; const d = new XRDevice(metaQuest3); d.installRuntime({ forceInstall: true }); window.__xrDevice = d;", resolveDir: path.join(__dirname, '..') },
    bundle: true, format: 'iife', write: false, logLevel: 'silent',
  }).outputFiles[0].text;
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await (await b.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  await p.addInitScript(() => localStorage.setItem('mechforce.settings', JSON.stringify({ quality: 'medium', speed: 4 })));
  await p.addInitScript(emu);
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('file://' + path.join(__dirname, '..', 'dist/web/index.html'));
  await p.waitForTimeout(2000);

  ok(await p.evaluate(() => document.getElementById('vr-btn').hidden), 'no Enter VR button on the title screen');
  await p.evaluate(() => { const a = window.__mf; a.stopAttract && a.stopAttract(); a.startLocal('skirmish'); });
  await p.waitForTimeout(300);
  await p.evaluate(() => { window.__mf.session.send({ t: 'settings', settings: { mapSize: 'S', seed: 'vr-test' } }); window.__mf.session.send({ t: 'start' }); });
  await p.waitForTimeout(2500); await p.keyboard.press('Enter');
  // wait for our first move
  for (let i = 0; i < 40 && (await p.evaluate(() => window.__mf.battle.ix.mode)) !== 'move'; i++) await p.waitForTimeout(500);
  ok(await p.evaluate(() => window.__mf.battle.ix.mode === 'move'), 'our turn, move step');
  ok(await p.evaluate(() => !document.getElementById('vr-btn').hidden), 'Enter VR button shown in the battle');

  await p.click('#vr-btn');
  await p.waitForTimeout(2500);
  ok(await p.evaluate(() => window.__mf.renderer.gl.xr.isPresenting), 'WebXR session started and presenting');
  ok(await p.evaluate(() => document.getElementById('vr-btn').hidden), 'button hidden while in VR');
  const scale = await p.evaluate(() => window.__mf.vr.S);
  ok(scale > 5 && scale < 80, `tabletop scale ${scale && scale.toFixed(1)} world units per metre`);
  await p.screenshot({ path: path.join(OUT, 'vr-view.png') });

  // aim the right controller at a hex we can move to, from a natural hand position
  const aim = await p.evaluate(() => {
    const a = window.__mf, bt = a.battle, r = a.renderer, vr = a.vr, st = bt.state, m = st.mechs[bt.ix.mechId];
    // a reachable hex two or three steps away
    let dest = null;
    for (let y = 0; y < st.map.h && !dest; y++) for (let x = 0; x < st.map.w && !dest; x++) {
      if ((x !== m.x || y !== m.y) && bt.hexReachable(x, y) && !st.mechs.some((o) => o.x === x && o.y === y)) dest = { x, y };
    }
    if (!dest) return { why: `mode ${bt.ix.mode}, mech ${bt.ix.mechId}` };
    // hex centre (same maths as core/hex.js center/toAxial) on top of the tile
    const q = dest.x - (dest.y - (dest.y & 1)) / 2, rr = dest.y;
    return { dest, world: { x: Math.sqrt(3) * (q + rr / 2), y: r.tileTop(dest.x, dest.y), z: 1.5 * rr } };
  });
  ok(aim && aim.dest, `found a reachable hex to aim at${aim && aim.dest ? ` (${aim.dest.x},${aim.dest.y})` : aim ? ' — ' + aim.why : ''}`);
  if (aim && aim.dest && aim.world) {
    // world point -> the headset's space (undo the rig), then point the controller at it
    const target = await p.evaluate((w) => {
      const vr = window.__mf.vr; vr.rig.updateMatrixWorld(true); const v = vr.rig.worldToLocal(vr.rig.position.clone().set(w.x, w.y, w.z));
      return { x: v.x, y: v.y, z: v.z };
    }, aim.world);
    await p.evaluate(({ tgt }) => {
      const d = window.__xrDevice, c = d.controllers.right, from = { x: 0.2, y: 1.15, z: -0.15 };
      c.position.set(from.x, from.y, from.z);
      let dx = tgt.x - from.x, dy = tgt.y - from.y, dz = tgt.z - from.z; const n = Math.hypot(dx, dy, dz); dx /= n; dy /= n; dz /= n;
      // rotation taking (0,0,-1) onto (dx,dy,dz)
      const ax = { x: 0 * dz - (-1) * dy, y: (-1) * dx - 0 * dz, z: 0 }; const dot = -dz;
      const w = 1 + dot; const q = { x: ax.x, y: ax.y, z: ax.z, w }; const l = Math.hypot(q.x, q.y, q.z, q.w);
      c.quaternion.set(q.x / l, q.y / l, q.z / l, q.w / l);
    }, { tgt: target });
    await p.waitForTimeout(800);
    const cur = await p.evaluate(() => window.__mf.battle.cursor);
    ok(cur.x === aim.dest.x && cur.y === aim.dest.y, `laser hover moves the cursor to the aimed hex (cursor ${cur.x},${cur.y})`);
    await p.screenshot({ path: path.join(OUT, 'vr-aim.png') });
    // look down at the table (pitch about 40 degrees) for a picture of the board
    await p.evaluate(() => { const q = window.__xrDevice.quaternion; const h = -0.35; q.set(Math.sin(h), 0, 0, Math.cos(h)); });
    await p.waitForTimeout(800);
    await p.screenshot({ path: path.join(OUT, 'vr-table.png') });
    await p.evaluate(() => window.__xrDevice.quaternion.set(0, 0, 0, 1));
    // trigger: pick the hex (like a click), which in the move step means "go here"
    await p.evaluate(() => window.__xrDevice.controllers.right.updateButtonValue('trigger', 1));
    await p.waitForTimeout(400);
    await p.evaluate(() => window.__xrDevice.controllers.right.updateButtonValue('trigger', 0));
    await p.waitForTimeout(800);
    const mode = await p.evaluate(() => window.__mf.battle.ix.mode);
    ok(mode === 'facing', `trigger on a reachable hex goes to the facing step (now: ${mode})`);
    // A confirms the facing: the mech moves
    const before = await p.evaluate(() => { const bt = window.__mf.battle; const m = bt.state.mechs[bt.ix.mechId]; return { id: m.id, x: m.x, y: m.y }; });
    await p.evaluate(() => window.__xrDevice.controllers.right.updateButtonValue('a-button', 1));
    await p.waitForTimeout(300);
    await p.evaluate(() => window.__xrDevice.controllers.right.updateButtonValue('a-button', 0));
    let moved = false;
    for (let i = 0; i < 30 && !moved; i++) {
      await p.waitForTimeout(500);
      moved = await p.evaluate((b) => { const m = window.__mf.battle.state.mechs[b.id]; return m.x !== b.x || m.y !== b.y; }, before);
    }
    ok(moved, 'A confirmed the move and the mech walked there (animations run on headset frames)');
  }
  // the wrist panel
  await p.waitForTimeout(600);
  const panel = await p.evaluate(() => { const v = window.__mf.vr; return { url: v.panel.canvas.toDataURL('image/png'), text: v.panel.last }; });
  fs.writeFileSync(path.join(OUT, 'vr-panel.png'), Buffer.from(panel.url.split(',')[1], 'base64'));
  ok(/turn|moving|choosing/i.test(panel.text), 'wrist panel shows whose turn it is');
  // sprites and particles are table-sized, not giant: a particle's quad in VR stays small on screen
  // leave VR
  await p.evaluate(() => window.__mf.vr.exit());
  await p.waitForTimeout(1500);
  ok(await p.evaluate(() => !window.__mf.renderer.gl.xr.isPresenting && window.__mf.renderer.viewScale === 1), 'leaving VR restores the normal view');
  ok(await p.evaluate(() => document.getElementById('labels').style.display === ''), 'mech labels back on screen');
  await p.waitForTimeout(800);
  await p.screenshot({ path: path.join(OUT, 'vr-after.png') });
  ok(!errs.length, `no page errors${errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''}`);
  await b.close();
  if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
  console.log('all passed');
})();
