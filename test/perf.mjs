// Frame pacing (src/client/perf.js) against simulated screens and slow frames.
import { perf, sampleFrame, frameDue, frameInterval } from '../src/client/perf.js';
let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; console.log('FAIL', msg); } };
// run `secs` of animation frames at `hz`, `slow(i)` adding GPU time to some frames
let clock = 1000;
function run(hz, secs, { idle = false, slow = () => 0 } = {}) {
  let t = clock, draws = [], i = 0;
  const end = t + secs * 1000, vs = 1000 / hz;
  while (t < end) {
    const extra = slow(i++);
    const dt = vs + extra - (extra % vs); // late frames land on the next vsync
    t += dt; sampleFrame(dt);
    if (frameDue(t, idle)) draws.push(t);
  }
  clock = t;
  const gaps = draws.slice(1).map((d, k) => d - draws[k]);
  return { fps: draws.length / secs, maxGap: Math.max(...gaps), minGap: Math.min(...gaps) };
}
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
for (const [hz, cap, want] of [[120, 40, 40], [120, 60, 60], [90, 45, 45], [60, 30, 30], [144, 60, 48], [90, 60, 45], [120, 0, 120], [60, 40, 30]]) {
  perf.settings = { fpsCap: cap, renderScale: 'auto', saver: 'off' };
  run(hz, 1); // let the refresh measurement settle
  ok(perf.refresh === hz, `measures ${hz} Hz (got ${perf.refresh})`);
  const r = run(hz, 3);
  ok(near(r.fps, want), `${hz} Hz screen, cap ${cap || 'none'}: ${r.fps.toFixed(1)} fps, wanted ${want}`);
  ok(r.maxGap - r.minGap < 1, `${hz} Hz cap ${cap}: evenly spaced frames (${r.minGap.toFixed(1)}–${r.maxGap.toFixed(1)} ms)`);
}
// battery saver always on: 40 while active, 20 idle, on a 120 Hz Go S panel
perf.settings = { fpsCap: 'auto', renderScale: 'auto', saver: 'on' };
run(120, 1);
ok(near(run(120, 3).fps, 40), 'saver on 120 Hz: 40 fps active');
ok(near(run(120, 3, { idle: true }).fps, 20), 'saver idle: 20 fps');
// a struggling GPU: every third frame takes 20 ms extra; refresh still reads 120 and the
// cap never starves the game below what the GPU manages
perf.settings = { fpsCap: 60, renderScale: 'auto', saver: 'off' };
const slow = run(120, 3, { slow: (i) => (i % 3 === 0 ? 20 : 0) });
ok(perf.refresh === 120, `slow frames don't fool the refresh measurement (${perf.refresh})`);
ok(slow.fps > 30, `slow GPU still gets every frame it can (${slow.fps.toFixed(1)} fps)`);
// uncapped desktop: every frame
perf.settings = { fpsCap: 'auto', renderScale: 'auto', saver: 'off' };
ok(frameInterval(false) === 0, 'desktop auto is uncapped');
console.log(fails ? `${fails} FAILED` : 'frame pacing ok');
process.exit(fails ? 1 : 0);
