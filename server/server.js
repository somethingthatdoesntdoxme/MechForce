// MechForce crossplay server.
// - Embedded in the desktop app (Windows / Steam Deck) when you "Host LAN game"
// - Or run standalone:  node dist/server.cjs --port 7373  (LAN or internet / VPS)
// Serves the web client over HTTP so any browser on the network can join, speaks
// JSON over WebSocket at /ws, answers GET /mf/info for discovery, and broadcasts
// UDP beacons on port 7374 so other desktop apps find it automatically.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import dgram from 'node:dgram';
import zlib from 'node:zlib';
import { WebSocketServer } from 'ws';
import { Room } from '../src/core/room.js';
import { PROTOCOL, VERSION } from '../src/core/data.js';

export const DEFAULT_PORT = 7373;
export const BEACON_PORT = 7374;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.wav': 'audio/wav', '.webmanifest': 'application/manifest+json' };

export function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address.split('.').map(Number), mask = a.netmask.split('.').map(Number);
      const bcast = ip.map((v, i) => (v | (~mask[i] & 255))).join('.');
      out.push({ iface: name, address: a.address, broadcast: bcast });
    }
  }
  return out;
}

export function startServer(opts = {}) {
  const port = opts.port || DEFAULT_PORT;
  const name = opts.name || os.hostname();
  const webRoot = opts.webRoot;
  const rooms = new Map();
  const log = opts.log || ((...a) => console.log('[mechforce]', ...a));

  const info = () => ({ mechforce: true, name, version: VERSION, protocol: PROTOCOL, port, rooms: [...rooms.values()].map((r) => r.summary()) });

  // Static files are kept in memory (and gzipped once) instead of re-read for every request:
  // the web client is one ~1.4 MB page, which gzips to roughly a third of that.
  const fileCache = new Map(); // path -> { mtimeMs, data, gz }
  const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.webmanifest']);
  const loadFile = (file, cb) => fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return cb(err || new Error('not a file'));
    const hit = fileCache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) return cb(null, hit);
    fs.readFile(file, (err2, data) => {
      if (err2) return cb(err2);
      const entry = { mtimeMs: st.mtimeMs, data, gz: COMPRESSIBLE.has(path.extname(file)) && data.length > 1024 ? zlib.gzipSync(data) : null };
      fileCache.set(file, entry);
      cb(null, entry);
    });
  });
  const root = path.resolve(webRoot || '.');

  const server = http.createServer((req, res) => {
    // Never let a bad request take the whole server (and every game on it) down
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/mf/info') {
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
        return res.end(JSON.stringify(info()));
      }
      if (!webRoot) { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('MechForce server ' + VERSION); }
      let p;
      try { p = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end('bad request'); }
      if (p === '/' || p === '') p = '/index.html';
      const file = path.resolve(root, '.' + p);
      if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
      loadFile(file, (err, f) => {
        if (err) { res.writeHead(404); return res.end('not found'); }
        const headers = { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', vary: 'accept-encoding' };
        const gzip = f.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
        if (gzip) headers['content-encoding'] = 'gzip';
        res.writeHead(200, headers);
        res.end(req.method === 'HEAD' ? undefined : gzip ? f.gz : f.data);
      });
    } catch (e) {
      log('http error', e.message);
      try { res.writeHead(500); res.end(); } catch {}
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });
  const sockets = new Map(); // clientId -> ws

  const sendTo = (cid, msg) => {
    const ws = sockets.get(cid);
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  };

  const makeRoom = (code) => {
    const room = new Room({
      code, send: sendTo, deltas: true,
      onEmpty: (r) => {
        setTimeout(() => {
          if (![...r.clients.values()].some((c) => c.connected)) { r.dispose(); rooms.delete(r.code); log('room closed', r.code); }
        }, r.game ? 10 * 60 * 1000 : 60 * 1000);
      },
    });
    while (rooms.has(room.code)) room.code = room.code.slice(0, 3) + String.fromCharCode(65 + Math.floor(Math.random() * 26));
    rooms.set(room.code, room);
    log('room opened', room.code);
    return room;
  };

  wss.on('connection', (ws, req) => {
    let room = null, cid = null;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
      // one malformed or unexpected message must never crash the server for everyone
      try { onMessage(msg); } catch (e) { log('message error', e.message); }
    });
    const onMessage = (msg) => {
      if (!room) {
        if (msg.t !== 'hello') return;
        if (msg.protocol !== PROTOCOL) {
          ws.send(JSON.stringify({ t: 'error', fatal: true, msg: `Version mismatch: server ${VERSION}, you have ${msg.version || '?'}. Update both apps.` }));
          return ws.close();
        }
        const code = (msg.room || '').toUpperCase().trim();
        if (msg.create) room = makeRoom();
        else if (code) room = rooms.get(code);
        else {
          // No code: join the one open lobby on this host, or start a fresh one
          const live = [...rooms.values()].filter((r) => !r.game && [...r.clients.values()].some((c) => c.connected));
          if (live.length === 1) room = live[0];
          else if (live.length === 0) room = makeRoom();
        }
        if (!room) { ws.send(JSON.stringify({ t: 'error', fatal: true, msg: code ? `Room ${code} not found` : 'Several games are running here — pick one by code.' })); return ws.close(); }
        // temporarily register before join so welcome can be delivered
        const tmpId = '__pending';
        sockets.set(tmpId, ws);
        const origSend = room.send;
        let assigned = null;
        room.send = (id, m) => { if (m.t === 'welcome' && !assigned) { assigned = id; sockets.delete(tmpId); sockets.set(id, ws); } origSend(id, m); };
        try { cid = room.join({ name: msg.name, platform: msg.platform, token: msg.token }); } finally { room.send = origSend; sockets.delete(tmpId); }
        sockets.set(cid, ws);
        log(`${msg.name || '?'} (${msg.platform || '?'}) joined ${room.code} from ${req.socket.remoteAddress}`);
        return;
      }
      room.handle(cid, msg);
    };
    ws.on('close', () => {
      if (room && cid) { if (sockets.get(cid) === ws) sockets.delete(cid); room.leave(cid); }
    });
  });

  const hb = setInterval(() => {
    for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch {} }
  }, 15000);

  // UDP beacons for desktop auto-discovery
  let beacon = null, beaconTimer = null;
  if (opts.beacon !== false) {
    try {
      beacon = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      beacon.bind(() => {
        try { beacon.setBroadcast(true); } catch {}
        beaconTimer = setInterval(() => {
          const msg = Buffer.from(JSON.stringify(info()));
          const targets = new Set(['255.255.255.255', ...lanAddresses().map((a) => a.broadcast)]);
          for (const t of targets) beacon.send(msg, BEACON_PORT, t, () => {});
        }, 1500);
      });
      beacon.on('error', (e) => log('beacon error', e.message));
    } catch (e) { log('beacon unavailable', e.message); }
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, opts.host || '0.0.0.0', () => {
      log(`listening on port ${port}; LAN: ${lanAddresses().map((a) => 'http://' + a.address + ':' + port).join('  ') || 'n/a'}`);
      resolve({
        port, rooms, info, addresses: lanAddresses(),
        close: () => new Promise((r) => { clearInterval(hb); clearInterval(beaconTimer); try { beacon && beacon.close(); } catch {} for (const ws of wss.clients) ws.terminate(); for (const rm of rooms.values()) rm.dispose(); wss.close(); server.close(() => r()); }),
      });
    });
  });
}

// Discovery listener (desktop clients)
export function listenBeacons(onHost) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('message', (buf, rinfo) => {
    try { const j = JSON.parse(String(buf)); if (j.mechforce) onHost({ ...j, address: rinfo.address }); } catch {}
  });
  sock.on('error', () => {});
  sock.bind(BEACON_PORT);
  return () => { try { sock.close(); } catch {} };
}

// CLI entry
const isMain = typeof process !== 'undefined' && process.argv[1] && /server\.(c?js|mjs)$/.test(process.argv[1]) && !process.versions.electron;
if (isMain) {
  const args = process.argv.slice(2);
  const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const here = typeof __dirname !== 'undefined' ? __dirname : path.dirname(new URL(import.meta.url).pathname);
  const web = get('--web', fs.existsSync(path.join(here, 'web', 'index.html')) ? path.join(here, 'web') : null);
  startServer({ port: +get('--port', process.env.PORT || DEFAULT_PORT), name: get('--name', os.hostname()), webRoot: web, beacon: !args.includes('--no-beacon') })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
