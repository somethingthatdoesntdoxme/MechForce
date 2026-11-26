// VR tabletop mode (WebXR). In a battle, "Enter VR" turns the battlefield into a model on a
// round table in front of you; you play it with the controllers:
//   trigger  point at a hex / mech and pick it (same as a mouse click)
//   A / B    confirm / back            X / Y   fire or stay here / move mode or melee
//   left stick   up/down/left/right (weapon list, cursor, menus)
//   right stick  turn the board (left/right), zoom (up/down); click: next mech or target
//   left stick click  end turn         grip (hold)  grab and drag the board
// A panel on your left wrist shows whose turn it is, the hint, the weapon list in an attack,
// and what the buttons do right now.
//
// How the scale works: rather than shrinking the world, the player is made a giant. The
// camera and controllers live in `rig`, scaled up by S, so one metre of real space covers S
// world units. Things that size themselves in view space (sprites, particles, point lights)
// correct for it via the view matrix scale / renderer.viewScale.
//
// Works wherever the browser has WebXR: Chrome/Edge on Windows with SteamVR (OpenXR), and
// the Meta Quest browser. Not offered in the desktop app (Electron can't open XR sessions).
import * as THREE from 'three';
import { input, markDevice, glyph } from './input.js';
import { toast } from './ui.js';

const UP = new THREE.Vector3(0, 1, 0);
const B = { trigger: 0, squeeze: 1, stick: 3, a: 4, b: 5 }; // xr-standard gamepad mapping
const TABLE_DIST = 0.7; // metres from you to the middle of the board
const BOARD_SIZE = 1.3; // metres across (board plus scenery) at the default zoom
const VR_HAZE = '#1a222b'; // the room's horizon colour, also the haze

export class VR {
  constructor(app) {
    this.app = app;
    this.r = app.renderer;
    this.supported = false;
    this.session = null;
    this.btn = document.createElement('button');
    this.btn.id = 'vr-btn';
    this.btn.className = 'btn primary';
    this.btn.innerHTML = '<span>Enter VR</span>';
    this.btn.title = 'Play this battle on a tabletop in VR';
    this.btn.hidden = true;
    this.btn.addEventListener('click', (e) => { e.stopPropagation(); this.enter(); });
    document.body.appendChild(this.btn);
    const xr = navigator.xr;
    if (xr && !window.mfNative) {
      const check = () => xr.isSessionSupported('immersive-vr').then((ok) => { this.supported = ok; this.syncButton(); }).catch(() => {});
      check();
      if (xr.addEventListener) xr.addEventListener('devicechange', check);
    }
    setInterval(() => this.syncButton(), 500);
  }

  syncButton() { this.btn.hidden = !(this.supported && !this.session && this.app.screen === 'battle'); }

  async enter() {
    if (this.session || !navigator.xr) return;
    let session;
    try {
      session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor'] });
    } catch (e) {
      toast(`Couldn't start VR: ${e.message || e}`);
      return;
    }
    const gl = this.r.gl;
    // standing on the floor if the headset knows where it is, else relative to your head
    const floor = !session.enabledFeatures || session.enabledFeatures.includes('local-floor');
    this.tableH = floor ? 0.8 : -0.5;
    gl.xr.enabled = true;
    gl.xr.setReferenceSpaceType(floor ? 'local-floor' : 'local');
    this.build();
    this.yaw = this.r.cam ? -this.r.cam.yaw - Math.PI / 2 : 0;
    this.zoom = 1;
    this.pan = new THREE.Vector3();
    this.session = session;
    this.syncButton();
    try {
      await gl.xr.setSession(session);
    } catch (e) {
      toast(`Couldn't start VR: ${e.message || e}`);
      session.end().catch(() => {});
      return;
    }
    session.addEventListener('end', () => this.onEnd());
    this.r.scene.add(this.rig);
    this.r.vrCam = this.cam;
    const fog = this.r.scene.fog;
    this.saved = { fog: fog ? fog.color.clone() : null, bg: this.r.scene.background };
    if (fog) { fog.near = 3; fog.far = 9; fog.color.set(VR_HAZE); } // metres, in VR
    this.r.scene.background = new THREE.Color(VR_HAZE);
    this.r.scene.traverse((o) => { if (o.userData.vrHide) { o.userData.vrWasVisible = o.visible; o.visible = false; } });
    this.r.labelLayer.style.display = 'none';
    this.prevDevice = input.device;
    markDevice('vr');
    this.hoverKey = null;
    this.active = 'right';
    this.held = {};
    gl.setAnimationLoop((t) => this.app.step(t, true));
  }

  onEnd() {
    const gl = this.r.gl;
    gl.setAnimationLoop(null);
    gl.xr.enabled = false;
    this.session = null;
    if (this.rig) this.r.scene.remove(this.rig);
    this.r.vrCam = null;
    this.r.viewScale = 1;
    if (this.saved) { if (this.saved.fog && this.r.scene.fog) this.r.scene.fog.color.copy(this.saved.fog); this.r.scene.background = this.saved.bg; }
    this.r.scene.traverse((o) => { if (o.userData.vrHide) o.visible = o.userData.vrWasVisible !== false; });
    this.r.labelLayer.style.display = '';
    if (this.prevDevice) markDevice(this.prevDevice);
    this.syncButton();
    window.dispatchEvent(new Event('resize')); // back to the window's own size
  }

  exit() { if (this.session) this.session.end().catch(() => {}); }

  // ---------------------------------------------------------------- scene pieces
  build() {
    if (this.rig) return;
    const gl = this.r.gl;
    this.rig = new THREE.Group();
    this.rig.name = 'vr-rig';
    this.cam = new THREE.PerspectiveCamera(70, 1, 0.03, 40);
    this.rig.add(this.cam);
    // controllers: a pointer laser on each, a simple body, and the wrist panel on the left
    this.hands = [0, 1].map((i) => {
      const ray = gl.xr.getController(i);
      const grip = gl.xr.getControllerGrip(i);
      const laser = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
        new THREE.LineBasicMaterial({ color: '#7fdcff', transparent: true, opacity: 0.85, fog: false }));
      laser.scale.z = 2;
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.008, 12, 8), new THREE.MeshBasicMaterial({ color: '#ffffff', fog: false }));
      dot.visible = false;
      ray.add(laser, dot);
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.12, 12), new THREE.MeshStandardMaterial({ color: '#2a3036', roughness: 0.6, metalness: 0.3 }));
      body.rotation.x = Math.PI / 2; body.position.z = 0.04;
      grip.add(body);
      const h = { i, ray, grip, laser, dot, src: null };
      ray.addEventListener('connected', (e) => { h.src = e.data; });
      ray.addEventListener('disconnected', () => { h.src = null; });
      this.rig.add(ray, grip);
      return h;
    });
    this.panel = new WristPanel();
    // furniture, in metres (children of the rig): a round table and a dark floor
    this.table = new THREE.Group();
    const top = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.04, 64), new THREE.MeshStandardMaterial({ color: '#2b2f35', roughness: 0.55, metalness: 0.35 }));
    top.position.y = -0.02;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(1, 0.012, 8, 96), new THREE.MeshStandardMaterial({ color: '#6b7684', roughness: 0.4, metalness: 0.7 }));
    rim.rotation.x = Math.PI / 2;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.14, 1, 24), new THREE.MeshStandardMaterial({ color: '#1d2126', roughness: 0.7, metalness: 0.4 }));
    stem.position.y = -0.5;
    this.tableTop = new THREE.Group(); this.tableTop.add(top, rim);
    this.table.add(this.tableTop, stem);
    this.stem = stem;
    const floor = new THREE.Mesh(new THREE.CircleGeometry(5, 64), new THREE.MeshStandardMaterial({ color: '#14171b', roughness: 0.95 }));
    floor.rotation.x = -Math.PI / 2;
    this.floor = floor;
    // a dim war room around you: gradient dome, haze matching its horizon
    const dome = new THREE.Mesh(new THREE.SphereGeometry(9, 32, 16), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { lo: { value: new THREE.Color(VR_HAZE) }, hi: { value: new THREE.Color('#05070a') } },
      vertexShader: 'varying float vY; void main() { vY = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform vec3 lo; uniform vec3 hi; varying float vY; void main() { gl_FragColor = vec4(mix(lo, hi, smoothstep(-0.1, 0.7, vY)), 1.0);\n#include <colorspace_fragment>\n}',
    }));
    dome.renderOrder = -10; dome.frustumCulled = false;
    this.rig.add(this.table, floor, dome);
  }

  // the board's place: centred on the table, turned by `yaw`, scaled so it's table-sized
  placeRig() {
    const r = this.r;
    const span = (r.mapSpan || 12) + 7; // board plus the scenery rings, world units from the middle
    const S0 = (span * 2) / BOARD_SIZE;
    const S = S0 / this.zoom;
    const C = (r.mapCenter || new THREE.Vector3()).clone().add(this.pan);
    const anchor = new THREE.Vector3(0, this.tableH, -TABLE_DIST);
    this.rig.scale.setScalar(S);
    this.rig.rotation.set(0, this.yaw, 0);
    this.rig.position.copy(C).sub(anchor.clone().applyAxisAngle(UP, this.yaw).multiplyScalar(S));
    this.rig.updateMatrixWorld(true);
    r.viewScale = S;
    this.S = S;
    // table: its top just under the board's base (world y = -0.62), wide enough for the board
    const topY = this.tableH - 0.62 / S;
    const radius = Math.min((span + 3) / S, 1.2); // the scenery's corners reach a little past `span`
    this.table.position.set(0, topY, -TABLE_DIST);
    this.tableTop.scale.set(radius, 1, radius);
    this.stem.scale.y = Math.max(0.05, topY - (this.tableH > 0 ? 0 : this.tableH - 0.8));
    this.stem.position.y = -this.stem.scale.y / 2;
    this.floor.position.y = this.tableH > 0 ? 0 : this.tableH - 0.8;
    this.floor.visible = this.table.visible = this.zoom <= 1.6; // zoomed right in, the board runs past the table
  }

  // ---------------------------------------------------------------- per frame
  update(dt) {
    if (!this.session) return;
    if (this.app.screen !== 'battle') { this.exit(); return; }
    this.placeRig();
    this.readPads(dt);
    this.point();
    this.panel.update(this, dt);
  }

  pads() {
    const out = {};
    for (const src of this.session.inputSources) if (src.gamepad && src.handedness !== 'none') out[src.handedness] = src.gamepad;
    return out;
  }

  // edge-triggered buttons, sticks as d-pad with auto-repeat, analogue board controls
  readPads(dt) {
    const pads = this.pads();
    const press = (key, pressed) => { const was = this.held[key]; this.held[key] = pressed; return pressed && !was; };
    const emit = (a) => input.emit(a, 'vr');
    for (const hand of ['left', 'right']) {
      const g = pads[hand];
      if (!g) continue;
      const btn = (i) => !!(g.buttons[i] && g.buttons[i].pressed);
      if (press(hand + 'trig', btn(B.trigger))) { this.active = hand; this.click(hand); }
      if (hand === 'right') {
        if (press('A', btn(B.a))) emit('confirm');
        if (press('B', btn(B.b))) emit('back');
        if (press('RS', btn(B.stick))) emit('rb');
      } else {
        if (press('X', btn(B.a))) emit('x');
        if (press('Y', btn(B.b))) emit('y');
        if (press('LS', btn(B.stick))) emit('view');
      }
      // grip: grab the board and drag it
      const grab = btn(B.squeeze);
      const h = this.handFor(hand);
      if (grab && h) {
        const p = h.grip.position.clone();
        if (!this.drag || this.drag.hand !== hand) this.drag = { hand, from: p, pan: this.pan.clone() };
        else {
          const d = p.clone().sub(this.drag.from); d.y = 0;
          d.applyAxisAngle(UP, this.yaw).multiplyScalar(this.S);
          this.pan.copy(this.drag.pan).sub(d);
        }
      } else if (this.drag && this.drag.hand === hand) this.drag = null;
      const ax = g.axes.length >= 4 ? [g.axes[2], g.axes[3]] : [g.axes[0] || 0, g.axes[1] || 0];
      if (hand === 'right') {
        if (Math.abs(ax[0]) > 0.2) this.yaw -= ax[0] * dt * 1.6;
        if (Math.abs(ax[1]) > 0.2) this.zoom = Math.min(4, Math.max(0.5, this.zoom * Math.exp(-ax[1] * dt * 1.3)));
      } else this.stickDpad(ax, dt, emit);
    }
  }

  stickDpad(ax, dt, emit) {
    const dir = Math.abs(ax[0]) > Math.abs(ax[1]) ? (ax[0] > 0.6 ? 'right' : ax[0] < -0.6 ? 'left' : null) : (ax[1] > 0.6 ? 'down' : ax[1] < -0.6 ? 'up' : null);
    if (!dir) { this.rep = null; return; }
    if (!this.rep || this.rep.dir !== dir) { this.rep = { dir, t: 0.45 }; emit(dir); return; }
    this.rep.t -= dt;
    if (this.rep.t <= 0) { this.rep.t = 0.14; emit(dir); }
  }

  handFor(hand) { return this.hands.find((h) => h.src && h.src.handedness === hand); }

  // laser from the active hand: hover the hex it points at; the other hand's laser dims
  point() {
    const battle = this.app.battle;
    this.frameN = (this.frameN || 0) + 1;
    for (const h of this.hands) {
      const on = !!h.src && h.src.handedness === this.active;
      h.laser.visible = !!h.src;
      h.laser.material.opacity = on ? 0.85 : 0.25;
      if (!on) { h.dot.visible = false; continue; }
      // raycasts against skinned mechs aren't free: every other frame is plenty for a pointer
      if (this.frameN % 2 && this.lastHit !== undefined) continue;
      const hit = this.cast(h);
      this.lastHit = hit;
      const len = hit ? hit.dist / this.S : 2;
      h.laser.scale.z = len;
      h.dot.visible = !!hit;
      h.dot.position.set(0, 0, -len);
      const key = hit ? `${hit.x},${hit.y}` : null;
      if (key !== this.hoverKey) { this.hoverKey = key; if (hit && battle) battle.pointerAt(hit, 'move'); }
    }
  }

  cast(h) {
    const o = new THREE.Vector3(), q = new THREE.Quaternion();
    h.ray.getWorldPosition(o); h.ray.getWorldQuaternion(q);
    return this.r.pickRay(o, new THREE.Vector3(0, 0, -1).applyQuaternion(q).normalize());
  }

  click(hand) {
    const h = this.handFor(hand);
    const battle = this.app.battle;
    if (!h || !battle) return;
    const hit = this.cast(h);
    if (hit) { this.hoverKey = `${hit.x},${hit.y}`; battle.pointerAt(hit, 'click'); }
  }
}

// ------------------------------------------------------------------ wrist panel
// A small screen on the left controller showing what the 2D HUD would: whose turn it is,
// the hint, weapons and hit chances while attacking, and the button prompts. It reads the
// battle's HUD (which keeps rendering off-screen), so it always matches the flat-screen game.
class WristPanel {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1024; this.canvas.height = 720;
    this.ctx = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.24 * 720 / 1024),
      new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, fog: false, toneMapped: false }));
    // above the left wrist, tilted towards your face
    this.mesh.position.set(0.02, 0.09, -0.02);
    this.mesh.rotation.set(-0.9, 0.25, 0);
    this.last = '';
    this.t = 0;
  }

  update(vr, dt) {
    const left = vr.handFor('left') || vr.hands[0];
    if (this.mesh.parent !== left.grip) left.grip.add(this.mesh);
    this.t -= dt;
    if (this.t > 0) return;
    this.t = 0.2;
    const info = readHud(vr.app.battle);
    const key = JSON.stringify(info);
    if (key === this.last) return;
    this.last = key;
    this.draw(info);
    this.tex.needsUpdate = true;
  }

  draw(info) {
    const c = this.ctx, W = this.canvas.width, H = this.canvas.height;
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(14,18,23,0.92)'; roundRect(c, 0, 0, W, H, 36); c.fill();
    c.strokeStyle = 'rgba(127,220,255,0.5)'; c.lineWidth = 4; roundRect(c, 2, 2, W - 4, H - 4, 34); c.stroke();
    let y = 70;
    c.fillStyle = info.turnColor || '#e8eef3';
    c.font = '600 46px "Chakra Petch", sans-serif';
    c.fillText(clip(c, info.turn || 'MechForce', W - 80), 40, y);
    y += 22;
    c.fillStyle = '#9fb0bd'; c.font = '30px "Chakra Petch", sans-serif';
    for (const line of wrap(c, info.hint || '', W - 80).slice(0, info.weapons.length ? 2 : 5)) { y += 40; c.fillText(line, 40, y); }
    if (info.weapons.length) {
      y += 22;
      c.font = '30px "Chakra Petch", sans-serif';
      for (const w of info.weapons.slice(0, 7)) {
        y += 44;
        if (w.focus) { c.fillStyle = 'rgba(127,220,255,0.18)'; c.fillRect(28, y - 34, W - 56, 44); }
        c.fillStyle = w.off ? '#5d6a74' : w.on ? '#ffd27a' : '#e8eef3';
        c.fillText(`${w.on ? '■' : '□'}  ${w.name}`, 40, y);
        c.textAlign = 'right'; c.fillText(w.pct, W - 40, y); c.textAlign = 'left';
      }
      if (info.fire) { y += 50; c.fillStyle = '#ffd27a'; c.font = '600 32px "Chakra Petch", sans-serif'; c.fillText(info.fire, 40, y); }
    }
    if (info.toast) {
      c.fillStyle = '#ff9a7a'; c.font = '30px "Chakra Petch", sans-serif';
      for (const line of wrap(c, info.toast, W - 80).slice(0, 2)) { y += 42; c.fillText(line, 40, y); }
    }
    // button prompts along the bottom
    c.font = '600 28px "Chakra Petch", sans-serif';
    let x = 40; const by = H - 40;
    for (const p of info.prompts.slice(0, 6)) {
      const g = p.g || '', label = p.label;
      const gw = g ? c.measureText(g).width + 24 : 0, lw = c.measureText(label).width;
      if (x + gw + lw > W - 40) break;
      if (g) { c.fillStyle = '#7fdcff'; roundRect(c, x, by - 32, gw, 42, 10); c.fill(); c.fillStyle = '#0e1217'; c.fillText(g, x + 12, by); }
      c.fillStyle = '#e8eef3'; c.fillText(label, x + gw + 8, by);
      x += gw + lw + 34;
    }
  }
}

// what the flat-screen HUD currently says, as plain data
function readHud(battle) {
  const ui = document.getElementById('ui');
  const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const info = { turn: '', turnColor: '', hint: '', weapons: [], fire: '', prompts: [], toast: '' };
  if (battle && battle.state) {
    const tmp = document.createElement('div');
    tmp.innerHTML = battle.statusText();
    info.turn = text(tmp);
    const b = tmp.querySelector('b');
    if (b && b.style.color) info.turnColor = b.style.color;
  }
  if (!ui) return info;
  info.hint = text(ui.querySelector('.stepbar .hint'));
  const rows = [...ui.querySelectorAll('.wrow')];
  info.weapons = rows.map((r) => ({
    name: text(r.querySelector('.wn b')),
    pct: text(r.querySelector('.pm em')),
    on: r.classList.contains('on'),
    off: r.classList.contains('off'),
    focus: r.classList.contains('focus'),
  }));
  if (rows.length) info.fire = text(ui.querySelector('.fire-btn'));
  info.prompts = [...ui.querySelectorAll('.prompts .prompt')].map((p) => ({ g: glyph(p.dataset.a) || '', label: text(p.querySelector('span:last-child')) }));
  info.toast = text(ui.querySelector('.toast'));
  return info;
}

function wrap(c, s, w) {
  const out = []; let line = '';
  for (const word of s.split(' ')) {
    const t = line ? line + ' ' + word : word;
    if (c.measureText(t).width > w && line) { out.push(line); line = word; } else line = t;
  }
  if (line) out.push(line);
  return out;
}
function clip(c, s, w) {
  if (c.measureText(s).width <= w) return s;
  while (s.length > 1 && c.measureText(s + '…').width > w) s = s.slice(0, -1);
  return s + '…';
}
function roundRect(c, x, y, w, h, r) {
  c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}
