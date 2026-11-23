// Runs the headless test suite in parallel (each test is its own process, so they can't
// interfere) and prints each test's output in one block once it finishes.
//   node test/run.mjs            all tests
//   node test/run.mjs ai fog     just these
//   node test/run.mjs -v         print passing tests' output too
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS = ['sim.mjs', 'chassis.mjs', 'fog.mjs', 'structures.mjs', 'dfa.mjs', 'pilots.mjs', 'units.mjs', 'delta.mjs', 'ai.mjs',
  'campaign.mjs', 'replay.mjs', 'missions.mjs', 'melee.mjs', 'teams.mjs', 'custom.mjs', 'four.mjs', 'handheld.cjs', 'perf.mjs'];

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const verbose = args.includes('-v');
const names = args.filter((a) => !a.startsWith('-'));
const list = names.length ? TESTS.filter((t) => names.some((n) => t.startsWith(n + '.') || t === n)) : TESTS;
if (!list.length) { console.error('no tests match', names.join(' ')); process.exit(2); }

// four.mjs opens a local server on a port, so keep it off the busiest stretch by running it first
const jobs = list.slice().sort((a, b) => (b === 'four.mjs') - (a === 'four.mjs'));
const width = Math.max(1, Math.min(jobs.length, (os.availableParallelism?.() ?? os.cpus().length)));
const t0 = Date.now();
const failed = [];

const run = (file) => new Promise((resolve) => {
  const start = Date.now();
  const child = spawn(process.execPath, [path.join(here, file)], { cwd: path.join(here, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('close', (code) => {
    const secs = ((Date.now() - start) / 1000).toFixed(1);
    // some tests report FAIL lines but still exit 0; count those as failures too
    const bad = code !== 0 || /^FAIL\b/m.test(out);
    console.log(`${bad ? 'FAIL' : 'ok  '} ${file.padEnd(16)} ${secs}s`);
    if (bad || verbose) console.log(out.replace(/^/gm, '    | ').trimEnd());
    if (bad) failed.push(file);
    resolve();
  });
});

const queue = jobs.slice();
await Promise.all(Array.from({ length: width }, async () => { while (queue.length) await run(queue.shift()); }));

const total = ((Date.now() - t0) / 1000).toFixed(1);
if (failed.length) { console.log(`\n${failed.length} of ${list.length} failed (${total}s): ${failed.join(', ')}`); process.exit(1); }
console.log(`\nall ${list.length} passed (${total}s)`);
