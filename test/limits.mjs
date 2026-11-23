// Server limits: room cap, per-address connections and room creation, flooding, full rooms,
// and that ordinary play is untouched by them.
import { startServer } from '../server/server.js';
import { PROTOCOL, VERSION } from '../src/core/data.js';
import WebSocket from 'ws';
let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; console.log('FAIL', msg); } else console.log('ok  ', msg); };
const port = 7380 + Math.floor(Math.random() * 50);
const srv = await startServer({ port, beacon: false, log: () => {}, maxRooms: 5, maxPerRoom: 3, maxPerIp: 8, createsPerMin: 4, msgsPerSec: 20 });
const url = `ws://127.0.0.1:${port}/ws`;
const open = [];
// connect, say hello, resolve with the first reply (welcome or error)
const hello = (extra = {}) => new Promise((resolve) => {
  const ws = new WebSocket(url); open.push(ws);
  let done = false;
  const fin = (v) => { if (!done) { done = true; resolve({ ws, ...v }); } };
  ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.t === 'welcome' || m.t === 'error') fin({ msg: m }); });
  ws.on('close', () => fin({ msg: { t: 'closed' } }));
  ws.on('error', () => fin({ msg: { t: 'closed' } }));
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', protocol: PROTOCOL, version: VERSION, name: 'T', ...extra })));
});

// creation rate: 4 per minute from one address
const made = [];
for (let i = 0; i < 5; i++) made.push(await hello({ create: true }));
ok(made.slice(0, 4).every((r) => r.msg.t === 'welcome'), 'four new games from one address are fine');
ok(made[4].msg.t === 'error' && /Too many new games/.test(made[4].msg.msg), `the fifth in a minute is refused (${made[4].msg.msg})`);
ok(srv.rooms.size === 4, `rooms open: ${srv.rooms.size}`);

// joining an existing room by code isn't limited by the creation rate; the room fills at 3
const code = made[0].msg.room;
const j1 = await hello({ room: code }), j2 = await hello({ room: code });
ok(j1.msg.t === 'welcome', 'second player joins by code');
ok(j2.msg.t === 'welcome', 'third player joins by code');
const j3 = await hello({ room: code });
ok(j3.msg.t === 'error' && /full/.test(j3.msg.msg), `a full game refuses more (${j3.msg.msg})`);
// a player who drops mid-game and reconnects with their token gets back in even when the
// game has filled up meanwhile (in the lobby a leaver just loses their seat, so fake the drop)
const room = srv.rooms.get(code);
const dropped1 = room.clients.get(j1.msg.id); dropped1.connected = false;
const filler = await hello({ room: code });
const back = await hello({ room: code, token: j1.msg.token });
ok(filler.msg.t === 'welcome' && back.msg.t === 'welcome' && back.msg.id === j1.msg.id, 'a reconnecting player always gets their seat back');

// per-address connection cap (8)
const many = [];
for (let i = 0; i < 4; i++) many.push(await hello({ room: made[1].msg.room }));
ok(many.some((r) => r.msg.t === 'error' && /Too many connections/.test(r.msg.msg)), `connections past the per-address cap are refused (${open.filter((w) => w.readyState === 1).length} open)`);
for (const w of open) w.close();
await new Promise((r) => setTimeout(r, 200));

// room cap (5): a fresh server so the creation rate isn't in the way
const srv2 = await startServer({ port: port + 60, beacon: false, log: () => {}, maxRooms: 2, createsPerMin: 99 });
const url2 = `ws://127.0.0.1:${port + 60}/ws`;
const h2 = (extra) => new Promise((resolve) => { const ws = new WebSocket(url2); open.push(ws); ws.on('message', (d) => resolve(JSON.parse(String(d)))); ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', protocol: PROTOCOL, version: VERSION, ...extra }))); });
const r1 = await h2({ create: true }), r2 = await h2({ create: true }), r3 = await h2({ create: true });
ok(r1.t === 'welcome' && r2.t === 'welcome' && r3.t === 'error' && /full/.test(r3.msg), `server-wide room cap (${r3.msg})`);

// flooding: thousands of messages in a burst gets the connection dropped; the server lives on
const flood = await hello({ create: true }).catch(() => null);
const fws = new WebSocket(url); open.push(fws);
await new Promise((r) => fws.on('open', r));
const closed = new Promise((r) => fws.on('close', r));
for (let i = 0; i < 3000; i++) fws.send('{"t":"ping","at":1}');
const dropped = await Promise.race([closed.then(() => true), new Promise((r) => setTimeout(() => r(false), 3000))]);
ok(dropped, 'a flooding connection is dropped');
const info = await (await fetch(`http://127.0.0.1:${port}/mf/info`)).json();
ok(info.mechforce, 'server still answering after all that');

for (const w of open) try { w.terminate(); } catch {}
await srv.close(); await srv2.close();
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
console.log('all passed');
process.exit(0);
