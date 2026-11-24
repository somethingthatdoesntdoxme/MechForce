import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

// Runs between the scene and the bloom. On real GPUs the scene is drawn into a half-float
// buffer: a single overflowing or NaN pixel (a specular hotspot, a degenerate normal) gets
// smeared by the bloom blur into a blinding white patch. Zero anything invalid and cap the
// brightness so the glow can never blow out the picture.
const SANITIZE = {
  uniforms: { tDiffuse: { value: null }, cap: { value: 3.0 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float cap; varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      bvec3 bad = bvec3(isnan(c.r) || isinf(c.r), isnan(c.g) || isinf(c.g), isnan(c.b) || isinf(c.b));
      vec3 rgb = any(bad) ? vec3(0.0) : clamp(c.rgb, 0.0, cap);
      gl_FragColor = vec4(rgb, (isnan(c.a) || isinf(c.a)) ? 1.0 : clamp(c.a, 0.0, 1.0));
    }`,
};
// Colour grade, applied after tone mapping (display space): contrast, saturation, then a
// lift (tints the shadows) and gain (tints the highlights). Set per map in buildMap.
const GRADE = {
  uniforms: { tDiffuse: { value: null }, lift: { value: new THREE.Vector3() }, gain: { value: new THREE.Vector3(1, 1, 1) }, sat: { value: 1 }, contrast: { value: 1 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform vec3 lift; uniform vec3 gain; uniform float sat; uniform float contrast; varying vec2 vUv;
    void main() {
      vec4 t = texture2D(tDiffuse, vUv);
      vec3 c = clamp((t.rgb - 0.5) * contrast + 0.5, 0.0, 1.0);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, sat);
      c = clamp(c * gain + lift * (1.0 - c), 0.0, 1.0);
      gl_FragColor = vec4(c, t.a);
    }`,
};
// Per-map light and grade. exposure applies on every quality setting; the grade needs the
// post-processing chain (medium and high).
const LOOK = {
  temperate: { exposure: 1.0, hemi: 1.05, sun: 1.9, lift: [0.0, 0.012, 0.03], gain: [1.0, 1.0, 0.98], sat: 1.08, contrast: 1.05 },
  desert: { exposure: 0.95, hemi: 1.05, sun: 1.65, lift: [0.02, 0.01, 0.0], gain: [1.02, 1.0, 0.95], sat: 1.02, contrast: 1.06 },
  snow: { exposure: 0.88, hemi: 1.0, sun: 1.5, lift: [0.0, 0.01, 0.035], gain: [0.98, 1.0, 1.03], sat: 1.1, contrast: 1.12 },
  lunar: { exposure: 1.05, hemi: 0.35, sun: 1.9, lift: [0.0, 0.0, 0.02], gain: [1.0, 1.0, 1.02], sat: 0.9, contrast: 1.12 },
  // volcanic was murky: more exposure and a warm bounce light from below, as if off the lava
  volcanic: { exposure: 1.3, hemi: 1.35, sun: 1.7, hemiGround: '#6a2a14', lift: [0.045, 0.014, 0.0], gain: [1.05, 0.98, 0.92], sat: 1.1, contrast: 1.0 },
};
import { center, DIR_ANGLE, toAxial, fromAxial, neighbor } from '../core/hex.js';
import { WEAPONS, TERRAIN, UNITS } from '../core/data.js';
import { view as palView, RING_SEGMENTS, shapeFor } from './palette.js';
import { totalArmor, maxArmor, operational } from '../core/rules.js';
import { renderScale, saverOn } from './perf.js';
import { buildMech, buildItem, triggerWeaponAnim, tickWeaponAnims, rollTracks, buildStructure, buildUnit, skinMerge, BAKED_MAT, bakedMat, disposeModel } from './models.js';
import { sfx } from './audio.js';
import { input } from './input.js';
import { rnd, patchNoise, hexAtPoint, liquidMaterial, skyDome, ParticleBatch } from './terrainfx.js';

const ELEV = 0.42;
export const topY = (e) => 0.2 + e * ELEV;
export function hexWorld(x, y) { const c = center(x, y); return new THREE.Vector3(c.px, 0, c.py); }
const facingRot = (f) => { const a = DIR_ANGLE[f] * Math.PI / 180; return Math.atan2(Math.cos(a), Math.sin(a)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const THEMES = {
  temperate: { dust: '#8f8068', zenith: '#6c97bd', t: ['#6a8a45', '#55773a', '#3c5b2e', '#857f6c', '#2f6584', '#1f4a68'], side: '#54473a', ground: '#3a4630', fog: '#9fb4bd', sky: '#b9ccd4', hemi: ['#d8ecff', '#4d5b3a'], sun: '#fff1d6', tree: ['#3f6b2c', '#2f5524'], trunk: '#5a4330', rock: '#7d786a', water: '#3a7aa0', lava: false },
  desert: { dust: '#d8b98a', zenith: '#d7a86c', t: ['#cfa96c', '#a7a25c', '#7d8443', '#b48a5c', '#3c8597', '#2a6576'], side: '#94714a', ground: '#b08b5c', fog: '#e9d1a6', sky: '#f0dcb4', hemi: ['#fff1d8', '#a07a4c'], sun: '#ffe2b0', tree: ['#7e8a3e', '#5f6b2e'], trunk: '#6b4b2e', rock: '#9c7a52', water: '#3f95a8', lava: false },
  snow: { dust: '#eef3f8', zenith: '#9fbbd3', t: ['#e4ebf1', '#b7c9bf', '#86a092', '#c3ccd6', '#7aa0bb', '#557d9b'], side: '#909eab', ground: '#c9d4de', fog: '#d6e1ea', sky: '#e3ecf3', hemi: ['#f0f6ff', '#8592a0'], sun: '#ffffff', tree: ['#3d5d4f', '#2d4a3e'], trunk: '#4e4038', rock: '#a9b4bf', water: '#8fb7d0', lava: false },
  lunar: { dust: '#a9abb2', zenith: '#000000', t: ['#8e9096', '#8e9096', '#8e9096', '#6f7178', '#55575e', '#45474d'], side: '#4b4d54', ground: '#2b2c31', fog: '#06070c', sky: '#05060a', hemi: ['#c8d0ff', '#1a1a22'], sun: '#f4f6ff', tree: ['#666', '#555'], trunk: '#444', rock: '#5d5f66', water: '#55575e', lava: false, stars: true },
  volcanic: { dust: '#5e4a3e', zenith: '#100604', t: ['#3e3734', '#4a3f30', '#352d24', '#2c2523', '#ff5a1f', '#ff3d0a'], side: '#25201e', ground: '#1d1715', fog: '#3a1d14', sky: '#2a130d', hemi: ['#ffb08a', '#2a1510'], sun: '#ffc39a', tree: ['#3b3326', '#2b241b'], trunk: '#2a201a', rock: '#3a302c', water: '#ff5a1f', lava: true },
};

function radialTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.3, 'rgba(255,255,255,0.7)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export class Renderer {
  constructor(canvas, labelLayer) {
    this.canvas = canvas;
    this.labelLayer = labelLayer;
    this.quality = 'high';
    this.speed = 1;
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    // If the graphics driver resets, keep the context and rebuild the battlefield when it's back
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; console.warn('WebGL context lost'); });
    canvas.addEventListener('webglcontextrestored', () => { this.lost = false; if (this.map) { const m = this.map; this.updateTerrain(m); } });
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.0;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 400);
    this.cam = { target: new THREE.Vector3(0, 0, 0), want: new THREE.Vector3(0, 0, 0), yaw: 0.0, pitch: 0.92, dist: 15, wantDist: 15 };
    this.hemi = new THREE.HemisphereLight('#ffffff', '#444444', 1.0);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight('#ffffff', 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun, this.sun.target);
    this.world = new THREE.Group(); this.scene.add(this.world);
    this.fxGroup = new THREE.Group(); this.scene.add(this.fxGroup);
    // Explosion flashes share a fixed pool of point lights. Adding and removing lights
    // changes every material's shader, and a big volley could put dozens in the scene at
    // once: on some PC graphics drivers that recompile fails and the 3D view goes blank.
    this.flashPool = [];
    for (let i = 0; i < 4; i++) { const l = new THREE.PointLight('#ffb35c', 0, 6, 2); l.userData.until = 0; this.scene.add(l); this.flashPool.push(l); }
    this.overlayGroup = new THREE.Group(); this.scene.add(this.overlayGroup);
    this.mechs = new Map();
    this.particles = [];
    this.beams = [];
    this.tex = radialTexture(); this.tex.userData.shared = true;
    // all spawned particles go through two batched meshes (glowing and plain): two draw calls
    this.partGlow = new ParticleBatch(500, this.tex, true);
    this.partPlain = new ParticleBatch(500, this.tex, false);
    this.scene.add(this.partGlow.mesh, this.partPlain.mesh);
    this.glowList = []; this.plainList = [];
    this.raycaster = new THREE.Raycaster();
    this.time = 0;
    this.queue = Promise.resolve();
    this.pendingAnims = 0;
    this.setupOverlays();
    this.composer = null;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setQuality(q) {
    this.quality = q;
    // the pixel ratio itself is set in resize(), where the handheld render scale applies
    this.dprCap = q === 'high' ? 2 : q === 'medium' ? 1.5 : 1;
    this.gl.shadowMap.enabled = q !== 'low';
    // the sun covers the whole map and never moves, so the shadow map only needs redrawing
    // when something moves: every frame while animating, a few times a second otherwise
    this.gl.shadowMap.autoUpdate = false; this.gl.shadowMap.needsUpdate = true;
    // idle refresh is only for slow things like turning turrets; busy = something is moving
    this.shadowEvery = q === 'high' ? [1, 20] : [2, 30];
    if (this.terrainGroup) this.terrainGroup.traverse((o) => { if (o.userData.tree) o.castShadow = q === 'high'; });
    this.sun.castShadow = q !== 'low';
    const sm = q === 'high' && !saverOn() ? 2048 : 1024;
    this.sun.shadow.mapSize.set(sm, sm);
    if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    // The bloom chain owns a dozen render targets: build it once and keep it (this used to
    // make a fresh one, leaking the old, every time settings were saved or power changed)
    const dropComposer = () => { if (!this.composer) return; for (const ps of this.composer.passes) ps.dispose?.(); this.composer.dispose(); this.composer = null; };
    if (q === 'low') dropComposer();
    else if (!this.composer) {
      this.composer = new EffectComposer(this.gl);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.composer.addPass(new ShaderPass(SANITIZE));
      this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.4, 0.4, 0.92);
      this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass());
      this.grade = new ShaderPass(GRADE);
      this.composer.addPass(this.grade);
      if (this.look) this.applyLook(this.look);
    }
    this.resize();
    this.gl.compile(this.scene, this.camera);
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, this.dprCap || 2);
    this.renderRatio = dpr * renderScale(w, h, dpr);
    this.gl.setPixelRatio(this.renderRatio);
    this.gl.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.composer) { this.composer.setSize(w, h); this.composer.setPixelRatio(this.gl.getPixelRatio()); }
  }

  // Terrain meshes live in their own group so fire, rubble and the map editor can rebuild
  // them without touching mechs, structures or effects.
  buildTerrain(map) {
    const th = this.theme;
    if (this.terrainGroup) { this.world.remove(this.terrainGroup); disposeModel(this.terrainGroup); }
    const tg = this.terrainGroup = new THREE.Group();
    this.world.add(tg);
    const { w, h } = map;
    const pos = [], col = [], idx = [];
    const lines = [];
    const tmpC = new THREE.Color(), sideC = new THREE.Color(), capC = new THREE.Color(), earth = new THREE.Color(th.side);
    const corners = [];
    for (let i = 0; i < 6; i++) { const a = (60 * i - 30) * Math.PI / 180; corners.push([Math.cos(a), Math.sin(a)]); }
    let vi = 0;
    const waterPos = [], waterIdx = [], waterShore = [];
    let wvi = 0;
    const aoTmp = [1, 1, 1, 1, 1, 1];
    const tileAt = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? -1 : map.t[y * w + x]);
    const isLiquid = (t) => t === 4 || t === 5;
    const pushCol = (c, k = 1) => col.push(c.r * k, c.g * k, c.b * k);
    // One hex column: a top with a small bevelled lip (so tiles read as solid blocks with soft
    // edges rather than flat cards), then sides with a band of the top colour (the grass or
    // snow line) over earth that darkens toward the bottom.
    const BEVEL = 0.05, RIN = 0.86, R = 0.995, CAP = 0.1;
    // `ao` (optional, per corner): darkening where a taller neighbour crowds the tile, baked
    // into the vertex colours, so the shading in nooks costs nothing at draw time
    const column = (cx, cz, top, base, topCol, sideCol, ao) => {
      const lip = top - BEVEL;
      pos.push(cx, top, cz); pushCol(topCol, ao ? 1 - (1 - (ao[0] + ao[1] + ao[2] + ao[3] + ao[4] + ao[5]) / 6) * 0.5 : 1);
      const ci = vi++;
      for (let k = 0; k < 6; k++) { pos.push(cx + corners[k][0] * RIN, top, cz + corners[k][1] * RIN); pushCol(topCol, 0.97 * (ao ? ao[k] : 1)); vi++; }
      for (let k = 0; k < 6; k++) idx.push(ci, ci + 1 + ((k + 1) % 6), ci + 1 + k);
      // bevel ring
      const bi = vi;
      for (let k = 0; k < 6; k++) { pos.push(cx + corners[k][0] * R, lip, cz + corners[k][1] * R); pushCol(topCol, 0.86 * (ao ? ao[k] : 1)); vi++; }
      for (let k = 0; k < 6; k++) {
        const i0 = ci + 1 + k, i1 = ci + 1 + ((k + 1) % 6), o0 = bi + k, o1 = bi + ((k + 1) % 6);
        idx.push(i0, i1, o1, i0, o1, o0);
      }
      // sides: cap band, then earth
      const capBottom = Math.max(base, lip - CAP);
      capC.copy(topCol).multiplyScalar(0.72);
      for (let k = 0; k < 6; k++) {
        const a = corners[k], b = corners[(k + 1) % 6];
        const ax = cx + a[0] * R, az = cz + a[1] * R, bx = cx + b[0] * R, bz = cz + b[1] * R;
        let s0 = vi;
        pos.push(ax, lip, az, bx, lip, bz, bx, capBottom, bz, ax, capBottom, az);
        pushCol(capC); pushCol(capC); pushCol(capC, 0.9); pushCol(capC, 0.9);
        vi += 4; idx.push(s0, s0 + 1, s0 + 2, s0, s0 + 2, s0 + 3);
        s0 = vi;
        pos.push(ax, capBottom, az, bx, capBottom, bz, bx, base, bz, ax, base, az);
        pushCol(sideCol); pushCol(sideCol); pushCol(sideCol, 0.5); pushCol(sideCol, 0.5);
        vi += 4; idx.push(s0, s0 + 1, s0 + 2, s0, s0 + 2, s0 + 3);
      }
    };
    // tile colour: theme colour, nudged by broad patches, a little per-tile jitter and height
    const tileColour = (out, t, x, y, e) => {
      out.set(th.t[t]);
      if (!isLiquid(t)) {
        const n = patchNoise(x + 40, y + 40, 4.5, 1) - 0.5, n2 = patchNoise(x + 9, y + 3, 2.2, 7) - 0.5;
        out.offsetHSL(n2 * 0.025, n * 0.1, n * 0.07 + (rnd(x * 31 + y * 17) - 0.5) * 0.045 + e * 0.025);
      }
      return out;
    };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const t = map.t[y * w + x], e = map.e[y * w + x];
      const c = center(x, y);
      const isWater = isLiquid(t);
      const top = isWater ? topY(0) - (t === 5 ? 0.3 : 0.18) : topY(e);
      tileColour(tmpC, t, x, y, e);
      // earth sides pick up a little of the tile colour so cliffs don't read as black voids
      sideC.copy(earth).lerp(tmpC, 0.22).offsetHSL(0, 0, 0.03 + e * 0.02);
      // corner occlusion from the two neighbours sharing each corner
      for (let k = 0; k < 6; k++) {
        let occ = 0;
        for (const da of [-30, 30]) {
          const a = (60 * k - 30 + da) * Math.PI / 180, nb = hexAtPoint(c.px + Math.cos(a) * 1.732, c.py + Math.sin(a) * 1.732);
          const nt = tileAt(nb.x, nb.y);
          if (nt < 0 || isLiquid(nt)) continue;
          occ = Math.max(occ, topY(map.e[nb.y * w + nb.x]) - top);
        }
        aoTmp[k] = occ > 0.05 ? 1 - Math.min(0.32, occ * 0.3) : 1;
      }
      column(c.px, c.py, top, -0.6, tmpC, sideC, aoTmp);
      // grid outline
      for (let k = 0; k < 6; k++) {
        const a = corners[k], b = corners[(k + 1) % 6];
        lines.push(c.px + a[0], top + 0.01, c.py + a[1], c.px + b[0], top + 0.01, c.py + b[1]);
      }
      if (isWater) {
        const wy = topY(0) - 0.06;
        waterPos.push(c.px, wy, c.py); waterShore.push(0);
        const w0 = wvi++;
        for (let k = 0; k < 6; k++) {
          const px = c.px + corners[k][0], pz = c.py + corners[k][1];
          waterPos.push(px, wy, pz);
          // a corner is on the shore if either neighbour sharing it is dry land (or off the map)
          let shore = 0;
          for (const da of [-30, 30]) {
            const a = (60 * k - 30 + da) * Math.PI / 180, nb = hexAtPoint(c.px + Math.cos(a) * 1.732, c.py + Math.sin(a) * 1.732);
            if (!isLiquid(tileAt(nb.x, nb.y))) shore = 1;
          }
          waterShore.push(shore); wvi++;
        }
        for (let k = 0; k < 6; k++) waterIdx.push(w0, w0 + 1 + ((k + 1) % 6), w0 + 1 + k);
      }
    }
    const mapIdxEnd = idx.length;
    // Scenery beyond the map edge: a few rings of lower, darker, unplayable hexes (some wooded)
    // so the battlefield sits in a landscape instead of floating over a flat plane.
    const rings = this.quality === 'low' ? 3 : 5;
    const decorTrees = [];
    for (let y = -rings; y < h + rings; y++) for (let x = -rings; x < w + rings; x++) {
      if (x >= 0 && y >= 0 && x < w && y < h) continue;
      const d = Math.max(-x, -y, x - (w - 1), y - (h - 1));
      const c = center(x, y);
      const n = patchNoise(x + 40, y + 40, 4.5, 1);
      // nearest map tile's height, falling away with distance, plus some rolling ground
      const nx = Math.max(0, Math.min(w - 1, x)), ny = Math.max(0, Math.min(h - 1, y));
      const edgeE = isLiquid(map.t[ny * w + nx]) ? 0 : map.e[ny * w + nx];
      const e = Math.max(0, Math.round(edgeE * 0.6 + (n - 0.35) * 3 - d * 0.35));
      const lava = map.theme === 'volcanic';
      const t = lava ? (n > 0.6 ? 2 : n > 0.4 ? 0 : 3) : n > 0.62 ? 2 : n > 0.5 ? 1 : (rnd(x * 13 + y * 7) > 0.85 ? 3 : 0);
      tileColour(tmpC, t, x, y, e);
      // clearly off the board: a step lower and noticeably darker, more so further out
      // (multiplying rather than shifting lightness so bright snow and moon dust darken too)
      tmpC.offsetHSL(0, -0.1, 0).multiplyScalar(Math.max(0.45, 0.7 - d * 0.05));
      sideC.copy(earth).lerp(tmpC, 0.22).multiplyScalar(0.8);
      const top = topY(e) - 0.5;
      column(c.px, c.py, top, -0.6, tmpC, sideC);
      if ((t === 1 || t === 2) && map.theme !== 'lunar') {
        const nT = this.quality === 'low' ? 1 : t === 2 ? 3 : 2;
        for (let i = 0; i < nT; i++) {
          const r = Math.sqrt(rnd(x * 7 + y * 13 + i * 3.1)) * 0.68, a = rnd(x * 5 + y * 11 + i * 7.7) * Math.PI * 2;
          decorTrees.push({ x: c.px + Math.cos(a) * r, z: c.py + Math.sin(a) * r, y: top, s: 0.7 + rnd(x + y * 3 + i) * 0.6, dark: t === 2 });
        }
      }
    }
    // map tiles and scenery share one vertex buffer but are separate meshes: clicks only ever
    // land on the map, and only the map casts shadows (flat shading needs no normals)
    const posAttr = new THREE.Float32BufferAttribute(pos, 3), colAttr = new THREE.Float32BufferAttribute(col, 3);
    const terrainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0.02, flatShading: true });
    const mapGeo = new THREE.BufferGeometry();
    mapGeo.setAttribute('position', posAttr); mapGeo.setAttribute('color', colAttr);
    mapGeo.setIndex(idx.slice(0, mapIdxEnd));
    const terrain = new THREE.Mesh(mapGeo, terrainMat);
    terrain.receiveShadow = true; terrain.castShadow = true;
    this.terrain = terrain;
    tg.add(terrain);
    const sceneryGeo = new THREE.BufferGeometry();
    sceneryGeo.setAttribute('position', posAttr); sceneryGeo.setAttribute('color', colAttr);
    sceneryGeo.setIndex(idx.slice(mapIdxEnd));
    const scenery = new THREE.Mesh(sceneryGeo, terrainMat);
    scenery.receiveShadow = true;
    tg.add(scenery);
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    tg.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: map.theme === 'snow' ? '#5a6878' : '#000000', transparent: true, opacity: map.theme === 'snow' ? 0.22 : 0.16 })));
    if (waterPos.length) {
      const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute(waterPos, 3));
      wg.setAttribute('shore', new THREE.Float32BufferAttribute(waterShore, 1)); wg.setIndex(waterIdx); wg.computeVertexNormals();
      this.liquidU = this.liquidU || { uTime: { value: 0 } };
      this.waterMat = liquidMaterial(th, th.lava, this.liquidU);
      tg.add(new THREE.Mesh(wg, this.waterMat));
    } else this.waterMat = null;
    // ground skirt
    const c0 = center(0, 0), c1 = center(w - 1, h - 1);
    this.bounds = { x0: c0.px - 1, z0: c0.py - 1, x1: c1.px + 1, z1: c1.py + 1 };
    const cx = (this.bounds.x0 + this.bounds.x1) / 2, cz = (this.bounds.z0 + this.bounds.z1) / 2;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: th.ground, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2; ground.position.set(cx, -0.55, cz); ground.receiveShadow = true;
    tg.add(ground);
    // trees and rocks
    const treeCount = this.quality === 'low' ? [0, 2, 3] : [0, 3, 6];
    const trees = [], rocks = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const t = map.t[y * w + x], e = map.e[y * w + x];
      const c = center(x, y);
      const n = t === 1 ? treeCount[1] : t === 2 ? treeCount[2] : 0;
      for (let i = 0; i < n; i++) {
        const r = Math.sqrt(rnd(x * 7 + y * 13 + i * 3.1)) * 0.68, a = rnd(x * 5 + y * 11 + i * 7.7) * Math.PI * 2;
        trees.push({ x: c.px + Math.cos(a) * r, z: c.py + Math.sin(a) * r, y: topY(e), s: 0.7 + rnd(x + y * 3 + i) * 0.6 * (t === 2 ? 1.25 : 1), dark: t === 2 });
      }
      if (t === 3) for (let i = 0; i < 4; i++) {
        const r = rnd(x * 3 + y * 7 + i) * 0.7, a = rnd(x * 9 + y * 2 + i * 5) * Math.PI * 2;
        rocks.push({ x: c.px + Math.cos(a) * r, z: c.py + Math.sin(a) * r, y: topY(e), s: 0.12 + rnd(x * 2 + y + i * 9) * 0.18 });
      }
    }
    const lunar = map.theme === 'lunar';
    // trees on the board (shadows on high quality) and off it (no shadows, no trunks, darker
    // to match the scenery): one instanced mesh each, so thousands of trees cost a few draws
    const cone = new THREE.ConeGeometry(0.22, 0.75, 6); cone.translate(0, 0.62, 0);
    const addTrees = (list, onBoard) => {
      if (!list.length || lunar) return;
      const im = new THREE.InstancedMesh(cone, new THREE.MeshStandardMaterial({ roughness: 0.85, flatShading: true }), list.length);
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), tc = new THREE.Color();
      let it = null;
      if (onBoard) {
        const trunk = new THREE.CylinderGeometry(0.04, 0.05, 0.3, 5); trunk.translate(0, 0.15, 0);
        it = new THREE.InstancedMesh(trunk, new THREE.MeshStandardMaterial({ color: th.trunk, roughness: 1 }), list.length);
      }
      list.forEach((tr, i) => {
        q.setFromAxisAngle(up, tr.x * 3); sc.set(tr.s, tr.s, tr.s); p.set(tr.x, tr.y, tr.z);
        m4.compose(p, q, sc); im.setMatrixAt(i, m4); if (it) it.setMatrixAt(i, m4);
        tc.set(tr.dark ? th.tree[1] : th.tree[0]).offsetHSL(0, 0, (rnd(i) - 0.5) * 0.08);
        if (!onBoard) tc.multiplyScalar(0.7);
        im.setColorAt(i, tc);
      });
      im.receiveShadow = true;
      if (onBoard) {
        im.castShadow = it.castShadow = this.quality === 'high';
        im.userData.tree = it.userData.tree = true;
        tg.add(im, it);
      } else tg.add(im);
    };
    addTrees(trees, true);
    addTrees(decorTrees, false);
    if (rocks.length) {
      const rg = new THREE.DodecahedronGeometry(1, 0);
      const rm = new THREE.InstancedMesh(rg, new THREE.MeshStandardMaterial({ color: th.rock, roughness: 0.95, flatShading: true }), rocks.length);
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
      rocks.forEach((r, i) => { q.setFromEuler(new THREE.Euler(r.x, r.z, r.x * r.z)); sc.set(r.s, r.s * 0.7, r.s); p.set(r.x, r.y + r.s * 0.3, r.z); m4.compose(p, q, sc); rm.setMatrixAt(i, m4); });
      rm.castShadow = true; rm.receiveShadow = true;
      tg.add(rm);
    }
    if (th.stars) {
      const sp = [];
      for (let i = 0; i < 900; i++) { const a = rnd(i) * Math.PI * 2, b = rnd(i + 999) * 0.45 + 0.08; sp.push(cx + Math.cos(a) * Math.cos(b) * 160, Math.sin(b) * 160, cz + Math.sin(a) * Math.cos(b) * 160); }
      const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
      tg.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: '#ffffff', size: 0.6, fog: false })));
      const planet = new THREE.Mesh(new THREE.SphereGeometry(12, 32, 16), new THREE.MeshStandardMaterial({ color: '#3a6fb0', emissive: '#10284a', emissiveIntensity: 0.6, fog: false }));
      planet.position.set(cx - 90, 45, cz - 110); tg.add(planet);
    }
  }
  updateTerrain(map) { this.map = map; this.buildTerrain(map); }

  // --------------------------------------------------------------- terrain
  buildMap(map) {
    this.gen = (this.gen || 0) + 1;
    this.map = map;
    // free the old battle's models, terrain and effects before dropping them (shared pieces stay)
    disposeModel(this.world);
    this.world.clear();
    this.marks = this.marks ? [] : this.marks;
    const th = THEMES[map.theme] || THEMES.temperate;
    this.theme = th;
    this.scene.background = new THREE.Color(th.fog);
    // distance haze: its range follows the camera (see updateCamera) so the board stays crisp
    // while the scenery and ground beyond fade into the sky
    this.scene.fog = new THREE.Fog(th.fog, 40, 110);
    this.sun.color.set(th.sun);
    this.applyLook(LOOK[map.theme] || LOOK.temperate);
    this.buildTerrain(map);
    const { w, h } = map;
    const cx = (this.bounds.x0 + this.bounds.x1) / 2, cz = (this.bounds.z0 + this.bounds.z1) / 2;
    // sun & shadow frustum cover the map
    const span = Math.max(this.bounds.x1 - this.bounds.x0, this.bounds.z1 - this.bounds.z0) * 0.65;
    this.sun.position.set(cx - 14, 26, cz - 10);
    this.sun.target.position.set(cx, 0, cz);
    const sc = this.sun.shadow.camera;
    sc.left = -span; sc.right = span; sc.top = span; sc.bottom = -span; sc.near = 1; sc.far = 80; sc.updateProjectionMatrix();
    this.cam.want.set(cx, 0, cz); this.cam.target.copy(this.cam.want);
    this.mapCenter = new THREE.Vector3(cx, 0, cz);
    this.mapSpan = Math.hypot(this.bounds.x1 - this.bounds.x0, this.bounds.z1 - this.bounds.z0) / 2;
    const dome = skyDome(th.fog, th.zenith); dome.position.set(cx, 0, cz); this.world.add(dome);
    // edge markers group (mission exits)
    this.edgeGroup = new THREE.Group(); this.world.add(this.edgeGroup);
    for (const m of this.mechs.values()) { this.fxGroup.remove(m.smoke); }
    this.mechs.forEach((m) => { m.label.remove(); });
    this.mechs.clear();
    this.mechGroup = new THREE.Group(); this.world.add(this.mechGroup);
    this.structGroup = new THREE.Group(); this.world.add(this.structGroup);
    this.envGroup = new THREE.Group(); this.world.add(this.envGroup);
    if (this.structs) this.structs.clear(); else this.structs = new Map();
    this.unitGroup = new THREE.Group(); this.world.add(this.unitGroup);
    if (this.units) this.units.clear(); else this.units = new Map();
    this.fireFx = []; this.smokeFx = [];
    this.itemObj = null;
  }

  // Light levels and colour grade for the current map
  applyLook(look) {
    this.look = look;
    const th = this.theme || THEMES.temperate;
    // a softer sun and more sky light: bright enough to read, without glints off water and metal
    this.hemi.color.set(th.hemi[0]); this.hemi.groundColor.set(look.hemiGround || th.hemi[1]);
    this.hemi.intensity = look.hemi; this.sun.intensity = look.sun;
    this.gl.toneMappingExposure = look.exposure;
    if (this.grade) {
      const u = this.grade.uniforms;
      u.lift.value.set(...look.lift); u.gain.value.set(...look.gain); u.sat.value = look.sat; u.contrast.value = look.contrast;
    }
  }

  tileTop(x, y) {
    const t = this.map.t[y * this.map.w + x];
    return t === 4 ? topY(0) - 0.35 : t === 5 ? topY(0) - 0.6 : topY(this.map.e[y * this.map.w + x]);
  }

  setExitEdges(edges) {
    disposeModel(this.edgeGroup); this.edgeGroup.clear();
    if (!edges || !edges.length) return;
    const geo = new THREE.CircleGeometry(0.9, 6); geo.rotateX(-Math.PI / 2); geo.rotateY(Math.PI / 6);
    for (const { x: ex, color } of edges) {
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthWrite: false });
      for (let y = 0; y < this.map.h; y++) {
        const p = hexWorld(ex, y);
        const m = new THREE.Mesh(geo, mat);
        m.position.set(p.x, topY(this.map.e[y * this.map.w + ex]) + 0.025, p.z);
        this.edgeGroup.add(m);
      }
      this.edgeMat = mat;
    }
  }

  // --------------------------------------------------------------- mechs
  syncMechs(state, animateNew = false) {
    const seen = new Set();
    for (const m of state.mechs) {
      seen.add(m.id);
      let v = this.mechs.get(m.id);
      if (!v) {
        const color = state.sides[m.side].color;
        const model = buildMech({ design: m.design, tons: m.tons, cls: m.cls, weapons: m.weapons, jump: m.jumpBase, body: m.body, mot: m.mot }, color);
        skinMerge(model.root);
        // its own copy of the baked material, so its edges can glow in its side's colour
        const rimMat = bakedMat(0x000000); rimMat.userData.team = new THREE.Color(color);
        model.root.traverse((o) => { if (o.isMesh && o.material === BAKED_MAT) o.material = rimMat; });
        // colour-blind mode: each side's ring has its own shape (hexagon, triangle, square, octagon)
        const seg = palView.shapes ? RING_SEGMENTS[m.side % 4] : 6;
        const ring = new THREE.Mesh(new THREE.RingGeometry(seg === 3 ? 0.55 : 0.62, seg === 3 ? 0.72 : 0.74, seg), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false }));
        ring.rotation.x = -Math.PI / 2; ring.rotation.z = seg === 6 ? Math.PI / 6 : seg === 4 ? Math.PI / 4 : seg === 3 ? Math.PI / 2 : 0;
        model.root.add(ring);
        ring.position.y = 0.03;
        const label = document.createElement('div');
        label.className = 'mlabel';
        label.style.setProperty('--side', color);
        label.innerHTML = `${shapeFor(m.side) ? `<em class="shape">${shapeFor(m.side)}</em>` : ''}<b></b><i><s class="arm"></s></i><i class="h"><s class="heat"></s></i>`;
        this.labelLayer.appendChild(label);
        v = { id: m.id, model, ring, label, prone: false, dead: false, walk: 0, torsoYaw: 0, wantYaw: 0, smoke: null, color, rimMat };
        this.mechs.set(m.id, v);
        this.mechGroup.add(model.root);
      }
      v.state = m;
      if (!v.animating) this.placeMech(v, m);
      this.updateMechLook(v, m);
    }
    for (const [id, v] of this.mechs) if (!seen.has(id)) { this.mechGroup.remove(v.model.root); disposeModel(v.model); v.label.remove(); if (v.ghost) { this.world.remove(v.ghost); disposeModel(v.ghost); } this.mechs.delete(id); }
    // item
    const it = state.item;
    if (it && !it.gone) {
      if (!this.itemObj) { this.itemObj = buildItem(it.name); this.world.add(this.itemObj); }
      if (it.carrier !== null && it.carrier !== undefined) {
        const cv = this.mechs.get(it.carrier);
        this.itemObj.visible = true;
        if (cv) { this.itemObj.position.copy(cv.model.root.position); this.itemObj.position.y += cv.model.height + 0.15; this.itemObj.scale.setScalar(0.7); this.itemCarrier = cv; }
      } else {
        this.itemCarrier = null;
        const p = hexWorld(it.x, it.y);
        this.itemObj.position.set(p.x, this.tileTop(it.x, it.y), p.z); this.itemObj.scale.setScalar(1); this.itemObj.visible = true;
      }
    } else if (this.itemObj) { this.itemObj.visible = false; this.itemCarrier = null; }
  }

  // --------------------------------------------------------------- structures
  syncStructures(state) {
    if (!this.structs) this.structs = new Map();
    const list = state.structures || [];
    const seen = new Set();
    for (const s of list) {
      seen.add(s.id);
      let sv = this.structs.get(s.id);
      if (!sv) {
        const color = s.team >= 0 && state.teams && state.teams[s.team] ? state.teams[s.team].color : '#9aa3ad';
        const model = buildStructure(s.kind, s.weapons || [], color);
        skinMerge(model.root);
        sv = { id: 's' + s.id, sid: s.id, model, state: s, wantYaw: 0, free: true, color };
        model.torso.rotation.y = 0;
        this.structGroup.add(model.root);
        this.structs.set(s.id, sv);
      }
      sv.state = s;
      const p = hexWorld(s.x, s.y);
      sv.model.root.position.set(p.x, this.tileTop(s.x, s.y), p.z);
      sv.model.root.rotation.y = facingRot(s.f || 0);
      sv.model.root.visible = !s.dead;
    }
    for (const [id, sv] of this.structs) if (!seen.has(id)) { this.structGroup.remove(sv.model.root); disposeModel(sv.model); this.structs.delete(id); }
  }

  // Infantry and vehicles. Views look like structure views ('u' + id), so aiming and firing
  // reuse the same code; troopers vanish from the squad as the platoon takes losses.
  syncUnits(state) {
    if (!this.units) this.units = new Map();
    if (!this.unitGroup) return;
    const seen = new Set();
    for (const u of state.units || []) {
      seen.add(u.id);
      let uv = this.units.get(u.id);
      if (!uv) {
        const color = u.team >= 0 && state.teams && state.teams[u.team] ? state.teams[u.team].color : '#b3a37a';
        const model = buildUnit(u.kind, u.weapons || [], color, u.motion, u.inf);
        if (!u.inf) skinMerge(model.root);
        uv = { id: 'u' + u.id, uid: u.id, model, state: u, wantYaw: 0, free: true, color, unit: true };
        this.unitGroup.add(model.root);
        this.units.set(u.id, uv);
      }
      uv.state = u;
      if (u.x >= 0 && !uv.moving) {
        const p = hexWorld(u.x, u.y);
        uv.model.root.position.set(p.x, this.unitY(u), p.z);
        uv.model.root.rotation.y = facingRot(u.f || 0);
        uv.model.torso.rotation.y = 0; uv.wantYaw = 0;
      }
      uv.model.root.visible = !u.dead && !u.hidden && u.x >= 0;
      this.unitLosses(uv);
    }
    for (const [id, uv] of this.units) if (!seen.has(id)) { this.unitGroup.remove(uv.model.root); disposeModel(uv.model); this.units.delete(id); }
  }
  unitY(u) { const t = this.map.t[u.y * this.map.w + u.x]; return t >= 4 ? topY(0) - 0.04 : this.tileTop(u.x, u.y); }
  unitLosses(uv) {
    const u = uv.state;
    if (!u.inf || !uv.model.troopers) return;
    const n = uv.model.troopers.length;
    const keep = u.dead ? 0 : Math.max(1, Math.ceil(n * u.troops / u.troopsMax));
    uv.model.troopers.forEach((t, k) => { t.visible = k < keep; });
  }
  async animUnitMove(uv, e, sp) {
    const root = uv.model.root;
    const a = root.position.clone();
    const p = hexWorld(e.x, e.y);
    const b = new THREE.Vector3(p.x, this.unitY({ ...uv.state, x: e.x, y: e.y }), p.z);
    const yaw0 = root.rotation.y, yaw1 = facingRot(e.f || 0);
    const dYaw = Math.atan2(Math.sin(yaw1 - yaw0), Math.cos(yaw1 - yaw0));
    uv.moving = true;
    root.visible = true;
    if (e.jump) sfx('jet', { pan: this.panOf(a), size: 0.4 });
    const dist = a.distanceTo(b);
    await this.tween(Math.min(900, 260 + dist * 130) / sp, (k) => {
      root.position.lerpVectors(a, b, k);
      if (e.jump) root.position.y += Math.sin(k * Math.PI) * 1.2;
      root.rotation.y = yaw0 + dYaw * Math.min(1, k * 3);
      if (!uv.state.inf && Math.random() < 0.3) this.spawn(root.position.clone().add(new THREE.Vector3(0, 0.08, 0)), { color: uv.state.motion === 'hover' ? '#cfd8dc' : '#8a7a66', size: 0.25, speed: 0.4, life: 0.7, normal: true, opacity: 0.35, grow: 2 });
    });
    uv.moving = false;
  }

  // Fire and smoke: flickering flames over burning hexes, smoke drifting with the wind
  setEnvironment(state) {
    if (!this.envGroup || !this.map) return;
    disposeModel(this.envGroup); this.envGroup.clear();
    this.fireFx = []; this.smokeFx = [];
    const { w } = this.map;
    const windA = state.wind !== undefined ? DIR_ANGLE[state.wind] * Math.PI / 180 : 0;
    this.windVec = new THREE.Vector3(Math.cos(windA), 0, Math.sin(windA));
    const mk = (color, normal, opacity) => new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, color, transparent: true, depthWrite: false, opacity, blending: normal ? THREE.NormalBlending : THREE.AdditiveBlending }));
    for (const k of Object.keys(state.fire || {}).map(Number)) {
      const x = k % w, y = Math.floor(k / w);
      const p = hexWorld(x, y); p.y = this.tileTop(x, y);
      for (let i = 0; i < (this.quality === 'low' ? 3 : 6); i++) {
        const sp = mk(i % 3 === 0 ? '#ffd04a' : '#ff6a1a', false, 0.9);
        const a = Math.random() * Math.PI * 2, r = Math.random() * 0.55;
        sp.position.set(p.x + Math.cos(a) * r, p.y + 0.25, p.z + Math.sin(a) * r);
        this.envGroup.add(sp);
        this.fireFx.push({ sp, base: sp.position.clone(), ph: Math.random() * 10, size: 0.5 + Math.random() * 0.5 });
      }
      const glow = mk('#ff7a2a', false, 0.35); glow.position.set(p.x, p.y + 0.4, p.z); glow.scale.setScalar(2.4); this.envGroup.add(glow);
      this.fireFx.push({ sp: glow, base: glow.position.clone(), ph: 0, size: 2.4, glow: true });
    }
    for (const [k, lvl] of Object.entries(state.smoke || {})) {
      const i = Number(k), x = i % w, y = Math.floor(i / w);
      const p = hexWorld(x, y); p.y = this.tileTop(x, y);
      for (let n = 0; n < (lvl > 1 ? 4 : 2); n++) {
        const sp = mk(lvl > 1 ? '#3c3a38' : '#7b7a78', true, lvl > 1 ? 0.42 : 0.26);
        sp.position.set(p.x + (Math.random() - 0.5) * 0.8, p.y + 0.8 + n * 0.5, p.z + (Math.random() - 0.5) * 0.8);
        this.envGroup.add(sp);
        this.smokeFx.push({ sp, base: sp.position.clone(), ph: Math.random() * 10, size: 1.6 + Math.random() * 0.8, lvl });
      }
    }
  }

  placeMech(v, m) {
    if (m.hidden) { v.model.root.visible = false; this.placeGhost(v, m); return; }
    if (v.ghost) v.ghost.visible = false;
    const p = hexWorld(m.x, m.y);
    v.model.root.position.set(p.x, this.tileTop(m.x, m.y), p.z);
    v.model.root.rotation.y = facingRot(m.f);
    v.model.root.visible = !m.exited;
    v.label.style.display = m.exited ? 'none' : '';
  }

  // Fog of war: a faded marker where an unseen enemy was last spotted
  placeGhost(v, m) {
    const g = m.ghost;
    if (!g || m.dead || m.exited) { if (v.ghost) v.ghost.visible = false; return; }
    if (!v.ghost) {
      const grp = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.74, 6), new THREE.MeshBasicMaterial({ color: v.color, transparent: true, opacity: 0.4, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2; ring.rotation.z = Math.PI / 6; ring.position.y = 0.04; grp.add(ring);
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.42, 1.3, 6, 1, true), new THREE.MeshBasicMaterial({ color: v.color, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
      col.position.y = 0.66; grp.add(col);
      const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.3, 3), new THREE.MeshBasicMaterial({ color: v.color, transparent: true, opacity: 0.5, depthWrite: false }));
      arrow.rotation.x = Math.PI / 2; arrow.position.set(0, 0.06, 0.55); grp.add(arrow);
      v.ghostCol = col;
      this.world.add(grp);
      v.ghost = grp;
    }
    const p = hexWorld(g.x, g.y);
    v.ghost.position.set(p.x, this.tileTop(g.x, g.y), p.z);
    v.ghost.rotation.y = facingRot(g.f);
    v.ghost.visible = true;
  }

  updateMechLook(v, m) {
    const mdl = v.model;
    const dead = m.dead;
    if (dead && !v.dead) {
      v.dead = true;
      mdl.root.traverse((o) => {
        if (!o.isMesh || !o.material || !o.material.color) return;
        const src = o.material;
        o.material = src.clone(); o.material.color.multiplyScalar(0.25); if (o.material.emissive) o.material.emissiveIntensity = 0;
        // the baked material's shader hooks don't survive clone()
        if (src.userData.baked) {
          o.material.onBeforeCompile = src.onBeforeCompile; o.material.customProgramCacheKey = src.customProgramCacheKey;
          o.material.userData.rimU = { value: new THREE.Color(0, 0, 0) }; // wrecks don't glow
          if (!src.userData.shared) src.dispose();
        }
      });
      mdl.body.rotation.x = 0.5; mdl.body.rotation.z = 0.35; mdl.body.position.y = -mdl.height * 0.3;
      v.ring.visible = false;
    }
    if (!dead) {
      const proneNow = m.prone;
      if (proneNow !== v.prone) { v.prone = proneNow; this.poseProne(v, proneNow ? 1 : 0); }
      // tracked / QuadVee vehicle pose
      if (!v.animating && !proneNow && (m.vmode === 'vehicle') !== (mdl.vk > 0.5)) mdl.setVehicle(m.vmode === 'vehicle' ? 1 : 0);
      mdl.mats.glass.emissiveIntensity = m.shutdown || m.pilot.ko ? 0.05 : 1.1;
      // limbs blown off
      // (parts are skinned into one mesh, so a lost arm is hidden by shrinking its bone)
      mdl.arms.forEach((a) => { a.sh.visible = !m.locGone[a.loc]; if (m.locGone[a.loc]) a.sh.scale.setScalar(0.0001); });
      mdl.legs.forEach((l) => { l.hip.scale.y = m.locGone[l.loc] ? 0.35 : 1; });
    }
    v.armorFrac = totalArmor(m) / maxArmor(m);
    v.damaged = !dead && v.armorFrac < 0.6;
    v.label.classList.toggle('dead', dead);
    v.label.querySelector('b').textContent = m.design;
    v.label.querySelector('.arm').style.width = (100 * totalArmor(m) / maxArmor(m)).toFixed(0) + '%';
    v.label.querySelector('.heat').style.width = Math.min(100, m.heat / 30 * 100).toFixed(0) + '%';
    v.label.classList.toggle('hot', m.heat >= 14);
  }

  // --------------------------------------------------------------- overlays
  setupOverlays() {
    const hexGeo = new THREE.CircleGeometry(0.9, 6); hexGeo.rotateX(-Math.PI / 2); hexGeo.rotateY(Math.PI / 6);
    this.reachMesh = new THREE.InstancedMesh(hexGeo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.38, depthWrite: false }), 28 * 20);
    this.reachMesh.count = 0; this.reachMesh.frustumCulled = false;
    this.overlayGroup.add(this.reachMesh);
    const ringGeo = new THREE.RingGeometry(0.78, 0.95, 6); ringGeo.rotateX(-Math.PI / 2); ringGeo.rotateY(Math.PI / 6);
    this.cursor = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: '#ffd166', transparent: true, opacity: 0.95, depthWrite: false }));
    this.cursorBeam = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 2.5, 6, 1, true), new THREE.MeshBasicMaterial({ color: '#ffd166', transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.cursorBeam.position.y = 1.25; this.cursor.add(this.cursorBeam);
    this.overlayGroup.add(this.cursor);
    this.facingArrows = new THREE.Group();
    const arrowGeo = new THREE.ConeGeometry(0.12, 0.3, 3); arrowGeo.rotateZ(-Math.PI / 2);
    for (let f = 0; f < 6; f++) {
      const a = new THREE.Mesh(arrowGeo, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.5, depthWrite: false }));
      const ang = DIR_ANGLE[f] * Math.PI / 180;
      a.position.set(Math.cos(ang) * 0.68, 0.08, Math.sin(ang) * 0.68);
      a.rotation.y = -ang;
      a.userData.f = f;
      this.facingArrows.add(a);
    }
    this.facingArrows.visible = false;
    this.overlayGroup.add(this.facingArrows);
    this.pathLine = null;
    this.targetLine = null;
  }

  setReach(cells) {
    const m4 = new THREE.Matrix4();
    const col = new THREE.Color();
    if (!this.map) return;
    const need = this.map.w * this.map.h;
    if (this.reachMesh.instanceMatrix.count < need) {
      this.overlayGroup.remove(this.reachMesh); this.reachMesh.dispose();
      this.reachMesh = new THREE.InstancedMesh(this.reachMesh.geometry, this.reachMesh.material, need);
      this.reachMesh.frustumCulled = false;
      this.overlayGroup.add(this.reachMesh);
    }
    let n = 0;
    for (const c of cells) {
      const p = hexWorld(c.x, c.y);
      m4.makeTranslation(p.x, this.tileTopFlat(c.x, c.y) + 0.02, p.z);
      this.reachMesh.setMatrixAt(n, m4);
      this.reachMesh.setColorAt(n, col.set(c.color));
      n++;
    }
    this.reachMesh.count = n;
    this.reachMesh.instanceMatrix.needsUpdate = true;
    if (this.reachMesh.instanceColor) this.reachMesh.instanceColor.needsUpdate = true;
  }
  tileTopFlat(x, y) { const t = this.map.t[y * this.map.w + x]; return t >= 4 ? topY(0) - 0.06 : topY(this.map.e[y * this.map.w + x]); }

  setCursor(x, y, color) {
    if (x === null || x === undefined) { this.cursor.visible = false; return; }
    const p = hexWorld(x, y);
    this.cursor.visible = true;
    this.cursor.position.set(p.x, this.tileTopFlat(x, y) + 0.03, p.z);
    if (color) this.cursor.material.color.set(color);
    this.cursorHex = { x, y };
  }

  setFacing(x, y, allowed, chosen) {
    if (x === null || x === undefined) { this.facingArrows.visible = false; return; }
    const p = hexWorld(x, y);
    this.facingArrows.visible = true;
    this.facingArrows.position.set(p.x, this.tileTopFlat(x, y) + 0.06, p.z);
    this.facingArrows.children.forEach((a) => {
      const f = a.userData.f;
      a.visible = allowed.includes(f);
      a.material.opacity = f === chosen ? 1 : 0.35;
      a.material.color.set(f === chosen ? '#ffd166' : '#ffffff');
      a.scale.setScalar(f === chosen ? 1.5 : 1);
    });
  }

  setPath(points, color = '#ffd166') {
    if (this.pathLine) { this.overlayGroup.remove(this.pathLine); this.pathLine.geometry.dispose(); this.pathLine = null; }
    if (!points || points.length < 2) return;
    const pts = [];
    let last = null;
    for (const p of points) {
      if (last && last.x === p.x && last.y === p.y) continue;
      const w = hexWorld(p.x, p.y);
      pts.push(new THREE.Vector3(w.x, this.tileTopFlat(p.x, p.y) + 0.12, w.z));
      last = p;
    }
    if (pts.length < 2) return;
    const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.2);
    const geo = new THREE.TubeGeometry(curve, pts.length * 8, 0.05, 6, false);
    this.pathLine = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false }));
    this.overlayGroup.add(this.pathLine);
  }

  setTargetLine(fromId, toId, ok = true) {
    if (this.targetLine) { this.overlayGroup.remove(this.targetLine); this.targetLine.geometry.dispose(); this.targetLine = null; }
    if (fromId === null || toId === null || fromId === undefined || toId === undefined) return;
    const a = this.viewOf(fromId), b = this.viewOf(toId);
    if (!a || !b) return;
    const pa = a.model.root.position.clone(); pa.y += a.model.height * 0.75;
    const pb = b.model.root.position.clone(); pb.y += b.model.height * 0.6;
    const geo = new THREE.BufferGeometry().setFromPoints([pa, pb]);
    this.targetLine = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: ok ? '#ff5a3c' : '#777777', dashSize: 0.25, gapSize: 0.15, transparent: true, opacity: 0.9, depthTest: false }));
    this.targetLine.computeLineDistances();
    this.overlayGroup.add(this.targetLine);
  }

  setActive(id) {
    for (const v of this.mechs.values()) { v.active = v.id === id; }
  }
  setHighlight(id) { for (const v of this.mechs.values()) v.hl = v.id === id; }

  clearOverlays() {
    this.setReach([]); this.setPath(null); this.setFacing(null); this.setTargetLine(null, null);
  }

  // --------------------------------------------------------------- camera
  focusHex(x, y, instant = false) {
    const p = hexWorld(x, y);
    this.cam.want.set(p.x, this.map ? this.tileTopFlat(x, y) : 0, p.z);
    if (instant) this.cam.target.copy(this.cam.want);
  }
  focusMech(id, instant) { const v = this.mechs.get(id); if (v) this.focusHex(v.state.x, v.state.y, instant); }

  updateCamera(dt) {
    const c = this.cam;
    const speed = this.camSpeed || 1;
    if (input.cam.x || input.cam.y) { c.wantYaw = null; c.wantPitch = null; }
    c.yaw += input.cam.x * dt * 2.2 * speed;
    c.pitch = Math.max(0.42, Math.min(1.35, c.pitch + input.cam.y * dt * 1.2 * speed));
    if (c.wantYaw !== null && c.wantYaw !== undefined) {
      const d = Math.atan2(Math.sin(c.wantYaw - c.yaw), Math.cos(c.wantYaw - c.yaw));
      if (Math.abs(d) < 0.01) { c.yaw = c.wantYaw; c.wantYaw = null; } else c.yaw += d * Math.min(1, dt * 4.5);
    }
    if (c.wantPitch !== null && c.wantPitch !== undefined) {
      c.pitch += (c.wantPitch - c.pitch) * Math.min(1, dt * 4);
      if (Math.abs(c.wantPitch - c.pitch) < 0.01) { c.pitch = c.wantPitch; c.wantPitch = null; }
    }
    if (input.zoom) { c.userDist = null; c.wantDist = Math.max(6, Math.min(34, c.wantDist + input.zoom * 1.2)); input.zoom = 0; }
    c.dist += (c.wantDist - c.dist) * Math.min(1, dt * 8);
    if (this.bounds) {
      c.want.x = Math.max(this.bounds.x0, Math.min(this.bounds.x1, c.want.x));
      c.want.z = Math.max(this.bounds.z0, Math.min(this.bounds.z1, c.want.z));
    }
    c.target.lerp(c.want, Math.min(1, dt * 5));
    const off = new THREE.Vector3(Math.sin(c.yaw) * Math.cos(c.pitch), Math.sin(c.pitch), Math.cos(c.yaw) * Math.cos(c.pitch)).multiplyScalar(c.dist);
    this.camera.position.copy(c.target).add(off);
    this.camera.lookAt(c.target);
    // bring the camera's matrices up to date now: labels are placed (project()) before the
    // scene is drawn, and would otherwise use last frame's camera, so they'd trail behind
    // and judder whenever the camera moves
    this.camera.updateMatrixWorld();
    if (this.scene.fog && this.mapSpan) {
      const f = this.scene.fog;
      f.near = c.dist + this.mapSpan * 0.9;
      f.far = f.near + 26 + this.mapSpan * 0.5;
    }
  }

  // Smooth 60° turns from the on-screen buttons
  rotateStep(dir) {
    const c = this.cam;
    const base = c.wantYaw ?? c.yaw;
    c.wantYaw = base + dir * Math.PI / 3;
  }
  restoreZoom() { const c = this.cam; if (c.userDist !== null && c.userDist !== undefined) { c.wantDist = c.userDist; c.userDist = null; } }
  zoomStep(dir) { this.cam.userDist = null; this.cam.wantDist = Math.max(6, Math.min(34, this.cam.wantDist + dir * 3)); }
  orbit(dx, dy) {
    const c = this.cam;
    c.wantYaw = null; c.wantPitch = null;
    c.yaw -= dx * 0.006;
    c.pitch = Math.max(0.42, Math.min(1.35, c.pitch + dy * 0.004));
  }

  // Swing the camera side-on to the line between two mechs and pull back until both are in frame.
  // a mech id, or 's<id>' for a structure, 'u<id>' for an infantry or vehicle unit
  viewOf(id) {
    if (typeof id === 'string') { const n = +id.slice(1); return id[0] === 's' ? this.structs && this.structs.get(n) : id[0] === 'u' ? this.units && this.units.get(n) : null; }
    return this.mechs.get(id);
  }
  frameMechs(idA, idB) {
    const a = this.viewOf(idA), b = this.viewOf(idB);
    if (!a || !b) return;
    const pa = a.model.root.position, pb = b.model.root.position;
    const c = this.cam;
    c.want.set((pa.x + pb.x) / 2, (pa.y + pb.y) / 2, (pa.z + pb.z) / 2);
    const dx = pb.x - pa.x, dz = pb.z - pa.z;
    const sep = Math.hypot(dx, dz);
    // camera offset direction is (sin yaw, cos yaw); perpendicular to the attack line
    const line = Math.atan2(dx, dz);
    const options = [line + Math.PI / 2, line - Math.PI / 2];
    const near = (y) => Math.abs(Math.atan2(Math.sin(y - c.yaw), Math.cos(y - c.yaw)));
    let yaw = options[0];
    if (near(options[1]) < near(options[0])) yaw = options[1];
    // only swing if the current view is looking too far along the line
    const along = Math.abs(Math.cos(c.yaw - line));
    if (along > 0.35 || sep > 3) c.wantYaw = c.yaw + Math.atan2(Math.sin(yaw - c.yaw), Math.cos(yaw - c.yaw));
    const aspect = Math.max(0.6, this.camera.aspect);
    const fit = (sep / 2 + 1.6) / Math.tan((this.camera.fov / 2) * Math.PI / 180) / Math.min(1, aspect) * 1.25;
    if (c.userDist === null || c.userDist === undefined) c.userDist = c.wantDist;
    c.wantDist = Math.max(c.wantDist, Math.min(60, Math.max(8, fit)));
    if (c.pitch < 0.75) c.wantPitch = 0.8;
    this.framed = idA + ':' + idB;
  }

  onScreenPos(pos, margin = 60) {
    const rect = this.canvas.getBoundingClientRect();
    const s = this.project(pos, rect);
    return !s.behind && s.x > rect.left + margin && s.x < rect.right - margin && s.y > rect.top + margin && s.y < rect.bottom - margin;
  }
  onScreen(id, margin = 40) {
    const m = this.mechs.get(id);
    if (!m) return true;
    const rect = this.canvas.getBoundingClientRect();
    const q = m.model.root.position.clone(); q.y += m.model.height * 0.6;
    const s = this.project(q, rect);
    return !s.behind && s.x > rect.left + margin && s.x < rect.right - margin && s.y > rect.top + margin && s.y < rect.bottom - margin;
  }
  async settleFraming(a, b) {
    const t0 = performance.now();
    const settled = () => {
      const c = this.cam;
      return (c.wantYaw === null || c.wantYaw === undefined) && (c.wantPitch === null || c.wantPitch === undefined) &&
        c.target.distanceTo(c.want) < 0.3 && Math.abs(c.dist - c.wantDist) < 0.4;
    };
    while (performance.now() - t0 < 900) {
      await sleep(60);
      if (settled() && this.onScreen(a) && this.onScreen(b)) return;
    }
    // Slow frame rate or still out of view: jump the camera straight to the framed position.
    const c = this.cam;
    for (let i = 0; i < 6; i++) {
      if (c.wantYaw !== null && c.wantYaw !== undefined) { c.yaw = c.wantYaw; c.wantYaw = null; }
      if (c.wantPitch !== null && c.wantPitch !== undefined) { c.pitch = c.wantPitch; c.wantPitch = null; }
      c.target.copy(c.want); c.dist = c.wantDist;
      this.updateCamera(0); this.camera.updateMatrixWorld();
      if (this.onScreen(a) && this.onScreen(b)) return;
      if (c.wantDist >= 60) return;
      c.wantDist = Math.min(60, c.wantDist + 5);
    }
  }

  // Screen-relative step: returns best neighbour direction for a stick/dpad vector (x right, y down)
  screenDirToHex(dx, dy) {
    const yaw = this.cam.yaw;
    // camera looks toward -offset; screen right in world = (cos yaw, 0, -sin yaw); screen up = (-sin yaw, 0, -cos yaw)
    const wx = dx * Math.cos(yaw) + dy * Math.sin(yaw);
    const wz = -dx * Math.sin(yaw) + dy * Math.cos(yaw);
    const ang = Math.atan2(wz, wx) * 180 / Math.PI;
    let best = 0, bd = 999;
    for (let f = 0; f < 6; f++) { let d = Math.abs(((ang - DIR_ANGLE[f]) % 360 + 540) % 360 - 180); if (d < bd) { bd = d; best = f; } }
    return best;
  }

  pick(clientX, clientY) {
    if (!this.terrain) return null;
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    // mechs first
    const mechObjs = [...this.mechs.values()].filter((v) => v.model.root.visible && !v.state.dead).map((v) => v.model.root);
    const mh = this.raycaster.intersectObjects(mechObjs, true)[0];
    if (mh) {
      let o = mh.object; while (o && !mechObjs.includes(o)) o = o.parent;
      const v = [...this.mechs.values()].find((q) => q.model.root === o);
      if (v) return { x: v.state.x, y: v.state.y, mech: v.id };
    }
    if (this.structs && this.structs.size) {
      const sObjs = [...this.structs.values()].filter((sv) => sv.model.root.visible).map((sv) => sv.model.root);
      const sh = this.raycaster.intersectObjects(sObjs, true)[0];
      if (sh) {
        let o = sh.object; while (o && !sObjs.includes(o)) o = o.parent;
        const sv = [...this.structs.values()].find((q) => q.model.root === o);
        if (sv) return { x: sv.state.x, y: sv.state.y, structure: sv.sid };
      }
    }
    if (this.units && this.units.size) {
      const uObjs = [...this.units.values()].filter((uv) => uv.model.root.visible).map((uv) => uv.model.root);
      const uh = this.raycaster.intersectObjects(uObjs, true)[0];
      if (uh) {
        let o = uh.object; while (o && !uObjs.includes(o)) o = o.parent;
        const uv = [...this.units.values()].find((q) => q.model.root === o);
        if (uv) return { x: uv.state.x, y: uv.state.y, unit: uv.uid };
      }
    }
    const hit = this.raycaster.intersectObject(this.terrain, false)[0];
    if (!hit) return null;
    const px = hit.point.x, pz = hit.point.z - (hit.face && hit.face.normal.y < 0.5 ? 0 : 0);
    const q = (Math.sqrt(3) / 3 * px - pz / 3), rr = 2 / 3 * pz;
    let rq = Math.round(q), rr2 = Math.round(rr), rs = Math.round(-q - rr);
    const dq = Math.abs(rq - q), dr = Math.abs(rr2 - rr), ds = Math.abs(rs + q + rr);
    if (dq > dr && dq > ds) rq = -rr2 - rs; else if (dr > ds) rr2 = -rq - rs;
    const o = fromAxial(rq, rr2);
    if (o.x < 0 || o.y < 0 || o.x >= this.map.w || o.y >= this.map.h) return null;
    return o;
  }

  // Pass `r` (the canvas rect) when projecting many points in a frame: reading the rect
  // after writing label styles forces the browser to redo layout, once per mech per frame.
  project(vec, r = this.canvas.getBoundingClientRect()) {
    const v = (this._pv || (this._pv = new THREE.Vector3())).copy(vec).project(this.camera);
    return { x: (v.x + 1) / 2 * r.width + r.left, y: (1 - v.y) / 2 * r.height + r.top, behind: v.z > 1 };
  }

  // --------------------------------------------------------------- particles & effects
  // Particle sprites are recycled rather than built and thrown away: an explosion alone used
  // to make ~30 materials that were garbage half a second later.
  takeSprite(color, normal, opacity = 1) {
    const s = (this.spritePool || (this.spritePool = [])).pop() ||
      new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, transparent: true, depthWrite: false }));
    const m = s.material;
    m.color.set(color); m.opacity = opacity;
    m.blending = normal ? THREE.NormalBlending : THREE.AdditiveBlending;
    s.position.set(0, 0, 0); s.scale.setScalar(1); s.visible = true;
    this.fxGroup.add(s);
    return s;
  }
  releaseSprite(s) {
    this.fxGroup.remove(s);
    if (this.spritePool.length < 600) this.spritePool.push(s); else s.material.dispose();
  }
  spawn(pos, opts) {
    const n = opts.n || 1;
    const cap = this.quality === 'low' ? 160 : 500;
    for (let i = 0; i < n; i++) {
      if (this.particles.length > cap) this.particles.shift();
      const p = pos.clone();
      if (opts.spread) p.x += (Math.random() - 0.5) * opts.spread, p.y += (Math.random() - 0.5) * opts.spread, p.z += (Math.random() - 0.5) * opts.spread;
      const size = (opts.size || 0.4) * (0.7 + Math.random() * 0.6);
      const sp = opts.speed ?? 2;
      const vel = new THREE.Vector3((Math.random() - 0.5) * sp, Math.random() * sp * (opts.up ?? 0.6) + (opts.rise || 0), (Math.random() - 0.5) * sp);
      if (opts.vel) vel.add(opts.vel);
      const c = (this.partColors || (this.partColors = new Map())).get(opts.color || '#ffaa33') || new THREE.Color(opts.color || '#ffaa33');
      this.partColors.set(opts.color || '#ffaa33', c);
      this.particles.push({ p, vel, c, glow: !opts.normal, s: size, a: opts.opacity ?? 1, life: opts.life || 0.6, age: 0, size, grow: opts.grow ?? 1.5, gravity: opts.gravity ?? 0, fade: opts.opacity ?? 1 });
    }
  }
  explosion(pos, big = 1) {
    this.spawn(pos, { n: Math.round(14 * big), color: '#ffcf6b', size: 0.5 * big, speed: 2.5 * big, life: 0.45, grow: 2 });
    this.spawn(pos, { n: Math.round(8 * big), color: '#ff6a2a', size: 0.7 * big, speed: 1.6 * big, life: 0.7, grow: 2.2 });
    this.spawn(pos, { n: Math.round(8 * big), color: '#3a3a3a', size: 0.8 * big, speed: 0.8, life: 1.6, rise: 0.8, normal: true, opacity: 0.55, grow: 2.5 });
    this.flash(pos, big);
  }
  // A brief bright bloom at the gun as it fires, with a little light thrown on the mech
  muzzleFlash(pos, color, big = 1) {
    this.spawn(pos, { n: 1, color: '#fff6e0', size: 0.8 * big, speed: 0, up: 0, life: 0.09, grow: 0.6 });
    this.spawn(pos, { n: 3, color, size: 0.32 * big, speed: 1.2 * big, up: 0.3, life: 0.12, grow: 0.4 });
    if (this.quality !== 'low') this.flash(pos, 0.3 * big);
  }
  // Dust kicked up underfoot, in the colour of the ground
  dust(pos, n = 3, size = 0.28) {
    if (!this.theme) return;
    if (this.quality === 'low') n = Math.ceil(n / 2);
    this.spawn(pos, { n, color: this.theme.dust, size: size * 1.35, speed: 0.8, up: 0.25, rise: 0.2, life: 0.9, normal: true, opacity: this.theme === THEMES.snow ? 0.7 : 0.58, grow: 2.2, spread: 0.35 });
  }
  flash(pos, big = 1) {
    // reuse the dimmest light in the pool
    let l = this.flashPool[0];
    for (const c of this.flashPool) if (c.intensity < l.intensity) l = c;
    l.position.copy(pos); l.distance = 6 * big; l.intensity = 8 * big;
    l.userData.tok = (l.userData.tok || 0) + 1;
    this.beams.push({ obj: l, age: 0, life: 0.25, light: true, pooled: true, tok: l.userData.tok, base: 8 * big });
  }
  beam(a, b, color, width, life = 0.3) {
    const len = a.distanceTo(b);
    // one unit tube per kind, scaled to each shot (they used to be built per shot and never freed)
    if (!this.beamGeo) {
      const tube = (seg) => { const gm = new THREE.CylinderGeometry(1, 1, 1, seg, 1, true); gm.translate(0, 0.5, 0); gm.rotateX(Math.PI / 2); return gm; };
      this.beamGeo = { core: tube(6), glow: tube(8) };
    }
    const core = new THREE.Mesh(this.beamGeo.core, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    core.scale.set(width, width, len);
    const glow = new THREE.Mesh(this.beamGeo.glow, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.scale.set(width * 3, width * 3, len);
    const g = new THREE.Group(); g.add(core, glow); g.position.copy(a); g.lookAt(b);
    this.fxGroup.add(g);
    this.beams.push({ obj: g, age: 0, life, mats: [core.material, glow.material] });
  }
  projectile(a, b, opts) {
    return new Promise((resolve) => {
      const s = this.takeSprite(opts.color, false); s.scale.setScalar(opts.size || 0.25); s.position.copy(a);
      const dur = opts.dur || 0.3;
      this.beams.push({ obj: s, age: 0, life: dur, sprite: true, proj: { a: a.clone(), b: b.clone(), arc: opts.arc || 0, trail: opts.trail }, done: resolve });
    });
  }

  tickFx(dt) {
    const glow = this.glowList, plain = this.plainList;
    glow.length = 0; plain.length = 0;
    let live = 0;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      p.age += dt;
      if (p.age >= p.life) continue;
      this.particles[live++] = p;
      p.vel.y -= p.gravity * dt;
      p.p.addScaledVector(p.vel, dt);
      p.vel.multiplyScalar(1 - dt * 1.5);
      const k = p.age / p.life;
      p.s = p.size * (1 + k * p.grow);
      p.a = (1 - k) * p.fade;
      (p.glow ? glow : plain).push(p);
    }
    this.particles.length = live;
    this.partGlow.update(glow); this.partPlain.update(plain);
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i];
      b.age += dt;
      const k = b.age / b.life;
      if (b.proj) {
        const t = Math.min(1, k);
        b.obj.position.lerpVectors(b.proj.a, b.proj.b, t);
        b.obj.position.y += Math.sin(t * Math.PI) * b.proj.arc;
        if (b.proj.trail && Math.random() < 0.8) this.spawn(b.obj.position, { color: '#9a9a9a', size: 0.18, speed: 0.2, life: 0.6, normal: true, opacity: 0.45, grow: 2 });
      } else if (b.light) { if (!b.pooled || b.obj.userData.tok === b.tok) b.obj.intensity = Math.max(0, b.base * (1 - k)); }
      else if (b.mats) b.mats.forEach((m, j) => { m.opacity = (1 - k) * (j ? 0.55 : 1); });
      if (k >= 1) {
        if (b.pooled) { if (b.obj.userData.tok === b.tok) b.obj.intensity = 0; }
        else if (b.sprite) this.releaseSprite(b.obj);
        else { this.fxGroup.remove(b.obj); if (b.mats) for (const m of b.mats) m.dispose(); }
        if (b.done) b.done();
        this.beams.splice(i, 1);
      }
    }
  }

  // --------------------------------------------------------------- per-frame
  // Tread marks left on the ground by tracked mechs; they fade over a few seconds
  treadMark(pos, yaw, gauge, scale) {
    if (!this.markGeo) { this.markGeo = new THREE.PlaneGeometry(1, 1); this.markGeo.rotateX(-Math.PI / 2); this.markGeo.userData.shared = true; this.marks = []; }
    for (const side of [-1, 1]) {
      const m = new THREE.Mesh(this.markGeo, new THREE.MeshBasicMaterial({ color: '#15130f', transparent: true, opacity: 0.6, depthWrite: false }));
      m.scale.set(0.16 * scale, 1, 0.34 * scale);
      m.position.set(pos.x + Math.cos(yaw) * side * gauge, pos.y + 0.025, pos.z - Math.sin(yaw) * side * gauge);
      m.rotation.y = yaw;
      m.renderOrder = 1;
      this.world.add(m);
      this.marks.push({ m, age: 0 });
    }
    while (this.marks.length > 240) { const o = this.marks.shift(); this.world.remove(o.m); o.m.material.dispose(); }
  }

  frame(dt) {
    if (this.liquidU) this.liquidU.uTime.value = this.time;
    if (this.fireFx) for (const f of this.fireFx) {
      const t = this.time * (f.glow ? 3 : 7) + f.ph;
      if (f.glow) { f.sp.material.opacity = 0.25 + Math.sin(t) * 0.08 + Math.random() * 0.05; continue; }
      const k = (t % 3) / 3;
      f.sp.position.set(f.base.x, f.base.y + k * 0.9, f.base.z);
      f.sp.scale.setScalar(f.size * (1 - k * 0.6) * (0.85 + Math.random() * 0.3));
      f.sp.material.opacity = 0.95 * (1 - k);
    }
    if (this.smokeFx) for (const f of this.smokeFx) {
      const k = ((this.time * 0.18 + f.ph) % 1);
      f.sp.position.copy(f.base).addScaledVector(this.windVec || (this._zero || (this._zero = new THREE.Vector3())), k * 1.2); f.sp.position.y += k * 1.4;
      f.sp.scale.setScalar(f.size * (0.8 + k * 0.9));
      f.sp.material.opacity = (f.lvl > 1 ? 0.45 : 0.28) * Math.sin(k * Math.PI);
    }
    if (this.structs) for (const sv of this.structs.values()) {
      const s = sv.state;
      if (!s || s.dead) continue;
      tickWeaponAnims(sv.model, dt, this.time);
      sv.model.torso.rotation.y += (sv.wantYaw - sv.model.torso.rotation.y) * Math.min(1, dt * 4);
      if (s.cf < s.cfMax / 2 && this.quality !== 'low' && Math.random() < dt * 3) {
        const p = sv.model.root.position.clone(); p.y += sv.model.height * 0.8;
        this.spawn(p, { color: '#4a4a4a', size: 0.3, speed: 0.25, rise: 0.9, life: 2, normal: true, opacity: 0.5, grow: 3 });
      }
    }
    if (this.units) for (const uv of this.units.values()) {
      if (uv.state.dead || !uv.model.root.visible) continue;
      tickWeaponAnims(uv.model, dt, this.time);
      uv.model.torso.rotation.y += (uv.wantYaw - uv.model.torso.rotation.y) * Math.min(1, dt * 5);
      if (!uv.state.inf && uv.state.struct < uv.state.structMax && this.quality !== 'low' && Math.random() < dt * 2) {
        const p = uv.model.root.position.clone(); p.y += uv.model.height * 0.8;
        this.spawn(p, { color: '#4a4a4a', size: 0.22, speed: 0.2, rise: 0.8, life: 1.6, normal: true, opacity: 0.45, grow: 3 });
      }
    }
    if (this.marks) for (let i = this.marks.length - 1; i >= 0; i--) {
      const o = this.marks[i]; o.age += dt;
      o.m.material.opacity = 0.6 * Math.max(0, 1 - o.age / 14);
      if (o.age > 14) { this.world.remove(o.m); o.m.material.dispose(); this.marks.splice(i, 1); }
    }
    this.time += dt;
    this.updateCamera(dt);
    this.tickFx(dt);
    const pulse = 0.5 + Math.sin(this.time * 5) * 0.5;
    if (this.cursor.visible) { this.cursor.material.opacity = 0.65 + pulse * 0.35; this.cursorBeam.material.opacity = 0.2 + pulse * 0.2; }
    if (this.waterMat && this.theme && this.theme.lava) this.waterMat.emissiveIntensity = 1.1 + Math.sin(this.time * 1.7) * 0.25;
    if (this.edgeMat) this.edgeMat.opacity = 0.14 + pulse * 0.14;
    if (this.itemObj && this.itemObj.visible) {
      this.itemObj.rotation.y += dt * 0.8;
      if (this.itemCarrier) { const p = this.itemCarrier.model.root.position; this.itemObj.position.set(p.x, p.y + this.itemCarrier.model.height + 0.2, p.z); }
    }
    const rect = this.canvas.getBoundingClientRect();
    for (const v of this.mechs.values()) {
      const m = v.state;
      if (!m) continue;
      v.ring.material.opacity = v.active ? 0.55 + pulse * 0.45 : v.hl ? 0.9 : 0.5;
      if (!m.dead) { tickWeaponAnims(v.model, dt, this.time); v.model.mats.vent.emissiveIntensity = 0.2 + Math.min(1, m.heat / 20) * 2.2 + (m.heat >= 14 ? Math.sin(this.time * 8) * 0.4 : 0); }
      v.ring.scale.setScalar(v.active ? 1 + pulse * 0.08 : 1);
      if (v.rimMat && !m.dead) v.rimMat.userData.rimU.value.copy(v.rimMat.userData.team).multiplyScalar(v.active ? 0.5 + pulse * 0.45 : v.hl ? 0.7 : 0.38);
      // idle sway & torso tracking
      if (!v.animating && !m.dead && !v.prone) {
        v.model.torso.rotation.y += (v.wantYaw - v.model.torso.rotation.y) * Math.min(1, dt * 6);
        v.model.body.position.y = Math.sin(this.time * 1.6 + v.id) * 0.01 + v.model.vOffset;
      }
      // damage: smoke that thickens as armour goes, sparks when badly hurt, flames near the end
      const hurt = m.dead ? 1 : v.damaged ? 1 - v.armorFrac : 0;
      if (hurt > 0 && !m.hidden) {
        const rate = (m.dead ? 8 : 2 + hurt * 9) * (this.quality === 'low' ? 0.35 : 1);
        if (Math.random() < dt * rate) {
          const p = v.model.root.position.clone(); p.y += v.model.height * (m.dead ? 0.4 : 0.55 + Math.random() * 0.3);
          p.x += (Math.random() - 0.5) * 0.3; p.z += (Math.random() - 0.5) * 0.3;
          this.spawn(p, { color: m.dead || hurt > 0.75 ? '#262626' : '#4a4a4a', size: 0.26 + hurt * 0.14, speed: 0.25, rise: 0.9, life: 2.2, normal: true, opacity: 0.4 + hurt * 0.2, grow: 3 });
          if ((m.dead || hurt > 0.8) && Math.random() < 0.45) this.spawn(p, { color: '#ff7a2a', size: 0.22, speed: 0.4, rise: 0.5, life: 0.45 });
        }
        if (!m.dead && hurt > 0.65 && Math.random() < dt * 1.5) {
          const p = this.bodyPoint(v, 0.3);
          this.spawn(p, { n: 4, color: '#ffd27a', size: 0.07, speed: 2.4, up: 0.8, life: 0.35, grow: 0, gravity: 6 });
        }
      }
      if (m.heat >= 14 && !m.dead && !m.hidden && Math.random() < dt * 3) {
        const p = v.model.root.position.clone(); p.y += v.model.height * 0.85;
        this.spawn(p, { color: '#dfe6ea', size: 0.2, speed: 0.3, rise: 0.7, life: 1.2, normal: true, opacity: 0.35, grow: 2.5 });
      }
      // label
      const lp = v.model.root.position.clone(); lp.y += v.model.height + 0.35;
      let s = this.project(lp, rect);
      const ghosted = m.hidden && v.ghost && v.ghost.visible;
      if (m.hidden && !ghosted) { v.label.style.display = 'none'; continue; }
      v.label.classList.toggle('ghost', !!ghosted);
      if (ghosted) { lp.copy(v.ghost.position); lp.y += 1.5; s = this.project(lp, rect); if (v.ghostCol) v.ghostCol.material.opacity = 0.08 + pulse * 0.08; }
      if (s.behind || m.exited || s.x < rect.left - 50 || s.x > rect.right + 50) v.label.style.display = 'none';
      else { v.label.style.display = ''; v.label.style.transform = `translate(${s.x - rect.left}px, ${s.y - rect.top}px) translate(-50%, -100%)`; v.label.classList.toggle('act', !!v.active); }
    }
    if (this.gl.shadowMap.enabled) {
      this.frameNo = (this.frameNo || 0) + 1;
      const busy = this.tweens > 0 || this.pendingAnims > 0;
      if (this.frameNo % (this.shadowEvery || [1, 4])[busy ? 0 : 1] === 0) this.gl.shadowMap.needsUpdate = true;
    }
    if (this.composer && this.quality !== 'low') this.composer.render(dt);
    else this.gl.render(this.scene, this.camera);
  }

  // --------------------------------------------------------------- event animation
  play(events, state, onEvent) {
    this.pendingAnims++;
    const gen = this.gen;
    // count animations per battlefield, so leftovers from the previous one (the title-screen
    // demo battle, say) still finishing in the background don't make this one look busy
    this.genAnims = this.genAnims || {};
    this.genAnims[gen] = (this.genAnims[gen] || 0) + 1;
    // a new battlefield (another battle, the editor) makes queued animations stale
    this.queue = this.queue.then(() => (this.gen === gen ? this.runEvents(events, state, onEvent) : null)).catch((e) => console.error(e)).finally(() => {
      this.pendingAnims--;
      if (!--this.genAnims[gen]) delete this.genAnims[gen];
      if (this.gen !== gen) return;
      if (this.terrainDirty) { this.terrainDirty = false; this.updateTerrain(state.map); }
      this.syncMechs(state);
      this.syncStructures(state);
      this.syncUnits(state);
      this.setEnvironment(state);
    });
    return this.queue;
  }
  get busy() { return !!(this.genAnims && this.genAnims[this.gen]); }

  muzzleWorld(v, loc) {
    const mz = v.model.muzzles[loc] || v.model.muzzles[2];
    const p = new THREE.Vector3(); mz.getWorldPosition(p); return p;
  }
  bodyPoint(v, spread = 0.35) {
    const p = v.model.root.position.clone();
    p.y += v.model.height * (0.45 + Math.random() * 0.35);
    p.x += (Math.random() - 0.5) * spread; p.z += (Math.random() - 0.5) * spread;
    return p;
  }
  panOf(pos) { const r = this.canvas.getBoundingClientRect(); const s = this.project(pos, r); return Math.max(-0.8, Math.min(0.8, ((s.x - r.left) / r.width) * 2 - 1)); }

  async runEvents(events, state, onEvent) {
    this.framed = null;
    const sp = this.speed || 1;
    const instant = sp >= 8;
    const gen = this.gen;
    for (const e of events) {
      // the battlefield changed under us (new battle, back to the title): stop, rather than
      // keep animating mechs by id, which would now be a different battle's mechs
      if (this.gen !== gen) return;
      if (onEvent) onEvent(e);
      if (instant) continue;
      const v = e.id !== undefined ? this.mechs.get(e.id) : null;
      switch (e.k) {
        case 'activate': if (v) { this.framed = null; this.restoreZoom(); this.focusMech(e.id); } break;
        case 'move': if (v) await this.animMove(v, e, sp); break;
        case 'sshot': {
          const sv = this.structs && this.structs.get(e.sid), tv = this.mechs.get(e.target);
          if (!sv || !tv) break;
          this.unfog(tv, state.mechs[e.target]);
          if (!this.onScreen(e.target)) { this.focusHex(sv.state.x, sv.state.y); await sleep(250 / sp); }
          await this.animShot(sv, tv, e, state, sp);
          break;
        }
        case 'umove': {
          const uv = this.units && this.units.get(e.uid);
          if (!uv) break;
          uv.state = state.units[e.uid] || uv.state;
          const p = hexWorld(e.x, e.y);
          if (!this.onScreenPos(new THREE.Vector3(p.x, 0.5, p.z))) { this.focusHex(e.x, e.y); await sleep(200 / sp); }
          await this.animUnitMove(uv, e, sp);
          break;
        }
        case 'ushot': {
          const uv = this.units && this.units.get(e.uid);
          const tv = e.target !== undefined ? this.mechs.get(e.target) : this.units && this.units.get(e.tu);
          if (!uv || !tv) break;
          uv.model.root.visible = true;
          if (e.target !== undefined) this.unfog(tv, state.mechs[e.target]);
          if (!this.onScreenPos(tv.model.root.position)) { this.focusHex(uv.state.x, uv.state.y); await sleep(220 / sp); }
          await this.animShot(uv, tv, e, state, sp);
          break;
        }
        case 'uhit': { const uv = this.units && this.units.get(e.uid); if (uv && e.dmg) { const u = state.units[e.uid]; this.float(uv, u && u.inf ? `-${e.dmg}` : String(e.dmg), 'dmg'); if (u) { uv.state = u; this.unitLosses(uv); } } break; }
        case 'umotive': { const uv = this.units && this.units.get(e.uid); if (uv) this.float(uv, e.mp ? 'MOTIVE DAMAGE' : 'IMMOBILISED', 'crit'); break; }
        case 'ugone': {
          const uv = this.units && this.units.get(e.uid);
          if (uv) {
            const p = uv.model.root.position.clone(); p.y += 0.2;
            if (e.inf) { this.spawn(p, { n: 10, color: '#8a7a66', size: 0.3, speed: 1, life: 0.9, normal: true, opacity: 0.5 }); }
            else { this.explosion(p, 1.3); sfx('boom', { size: 0.9, pan: this.panOf(p) }); }
            uv.state = { ...uv.state, dead: true }; uv.model.root.visible = false;
            await sleep(300 / sp);
          }
          break;
        }
        case 'uexit': {
          const uv = this.units && this.units.get(e.uid);
          if (uv) { this.float(uv, 'AWAY', 'info'); await sleep(350 / sp); uv.state = { ...uv.state, dead: true }; uv.model.root.visible = false; }
          break;
        }
        case 'units': break;
        case 'sgone': {
          const sv = this.structs && this.structs.get(e.sid);
          if (sv) { const p = sv.model.root.position.clone(); p.y += sv.model.height * 0.5; this.explosion(p, 2); sfx('boom', { size: 1.5, pan: this.panOf(p) }); sv.model.root.visible = false; this.terrainDirty = true; await sleep(450 / sp); }
          break;
        }
        case 'terrain': this.terrainDirty = true; break;
        case 'fire': { const p = hexWorld(e.x, e.y); p.y = this.tileTop(e.x, e.y) + 0.3; this.spawn(p, { n: 16, color: '#ff7a1a', size: 0.5, speed: 1.2, rise: 1.2, life: 0.9 }); sfx('flamer', { pan: this.panOf(p) }); break; }
        case 'shot': case 'melee': {
          if (!v) break;
          if (e.utarget !== undefined) {
            const tv = this.units && this.units.get(e.utarget);
            if (!tv) break;
            if (!this.onScreen(e.id)) { this.focusHex(tv.state.x, tv.state.y); await sleep(250 / sp); }
            await this.animShot(v, tv, e, state, sp);
            break;
          }
          if (e.starget !== undefined) {
            const tv = this.structs && this.structs.get(e.starget);
            if (!tv) break;
            if (!this.onScreen(e.id)) { this.focusHex(tv.state.x, tv.state.y); await sleep(250 / sp); }
            await this.animShot(v, tv, e, state, sp);
            break;
          }
          this.unfog(v, state.mechs[e.id]); this.unfog(this.mechs.get(e.target), state.mechs[e.target]);
          const key = e.id + ':' + e.target;
          if (this.framed !== key || !this.onScreen(e.id) || !this.onScreen(e.target)) { this.frameMechs(e.id, e.target); await this.settleFraming(e.id, e.target); }
          if (e.k === 'shot') await this.animShot(v, this.mechs.get(e.target), e, state, sp);
          else if (e.kind === 'dfa') await this.animDFA(v, this.mechs.get(e.target), e, sp);
          else await this.animMelee(v, this.mechs.get(e.target), e, sp);
          break;
        }
        case 'blast': await this.animBlast(e, sp); break;
        case 'shove': if (v && v.model.root.visible) {
          // knocked back a hex by a charge or a push: skid there, kicking up dirt
          const root = v.model.root, a0 = root.position.clone(), b = hexWorld(e.x, e.y);
          const b0 = new THREE.Vector3(b.x, this.tileTop(e.x, e.y), b.z);
          this.spawn(a0.clone().add(new THREE.Vector3(0, 0.15, 0)), { n: 14, color: '#8a7a66', size: 0.45, speed: 1.8, life: 0.9, normal: true, opacity: 0.5 });
          v.animating = true;
          await this.tween(260 / sp, (k) => { const q = 1 - (1 - k) * (1 - k); root.position.lerpVectors(a0, b0, q); if (b0.y < a0.y - 0.5) root.position.y = a0.y + (b0.y - a0.y) * k * k; });
          v.animating = false;
        } break;
        case 'eject': if (v) await this.animEject(v, e, sp); break;
        case 'selfdestruct': if (v) {
          if (e.ok) { this.float(v, 'REACTOR OVERLOAD', 'crit'); sfx('alarm'); const p = this.bodyPoint(v, 0.1); for (let i = 0; i < 4; i++) { this.flash(p, 0.6 + i * 0.3); await sleep(140 / sp); } }
          else { this.float(v, 'SAFETIES HOLD', 'info'); sfx('ui-err'); await sleep(300 / sp); }
        } break;
        case 'blasthit': if (v) this.float(v, String(e.dmg), 'dmg'); break;
        case 'boom': if (v) { const p = this.bodyPoint(v, 0.2); this.explosion(p, 1.6); sfx('boom', { size: 1.3, pan: this.panOf(p) }); await sleep(400 / sp); } break;
        case 'locgone': if (v) { const p = this.bodyPoint(v); this.explosion(p, 0.8); this.spawn(p, { n: 16, color: '#ffe08a', size: 0.12, speed: 5, life: 0.5, gravity: 9, grow: 0 }); } break;
        case 'crit': if (v) { this.float(v, critShort(e.code), 'crit'); } break;
        case 'convert': case 'mode': if (v) { await this.animConvert(v, e.vmode === 'vehicle', sp, e.k === 'convert'); } break;
        case 'fall': if (v) { v.prone = true; await this.tween(300 / sp, (k) => this.poseProne(v, k)); sfx('melee', { pan: 0 }); this.spawn(v.model.root.position.clone().add(new THREE.Vector3(0, 0.2, 0)), { n: 12, color: '#8a7a66', size: 0.4, speed: 1.5, life: 1, normal: true, opacity: 0.5 }); } break;
        case 'destroyed': if (v) { const p = this.bodyPoint(v, 0.1); this.explosion(p, 2.2); sfx('boom', { size: 1.6, pan: this.panOf(p) }); v.state = state.mechs[e.id]; this.updateMechLook(v, state.mechs[e.id]); this.float(v, 'DESTROYED', 'kill'); await sleep(650 / sp); } break;
        case 'shutdown': if (v) { this.float(v, 'SHUTDOWN', 'crit'); v.model.mats.glass.emissiveIntensity = 0.05; sfx('alarm'); } break;
        case 'ko': if (v) this.float(v, 'PILOT KO', 'crit'); break;
        case 'pickup': if (v) { this.float(v, 'PICKED UP', 'info'); sfx('ui-ok'); } break;
        case 'exit': if (v) { await this.tween(500 / sp, (k) => { v.model.root.position.y += 0.03; v.model.root.scale.setScalar(1 - k * 0.9); }); v.model.root.visible = false; v.model.root.scale.setScalar(1); } break;
        case 'heat': if (v && e.gen !== undefined && e.heat >= 14) this.float(v, `HEAT ${e.heat}`, 'heat'); break;
        case 'psr': if (v) this.float(v, `PILOTING ${e.roll}/${e.tn}`, e.roll >= e.tn ? 'info' : 'crit'); break;
        default: break;
      }
    }
  }

  tween(ms, fn) {
    this.tweens = (this.tweens || 0) + 1;
    return new Promise((resolve) => {
      const t0 = performance.now();
      const step = () => {
        const k = Math.min(1, (performance.now() - t0) / ms);
        fn(k);
        if (k < 1) requestAnimationFrame(step); else { this.tweens--; this.gl.shadowMap.needsUpdate = true; resolve(); }
      };
      step();
    });
  }

  // A four-legged mech topples onto its side; anything else falls on its face
  poseProne(v, k) {
    const b = v.model.body;
    if (v.model.quad) { b.rotation.z = 1.25 * k; b.rotation.x = 0; b.position.y = 0.15 * k; }
    else { b.rotation.x = 1.35 * k; b.rotation.z = 0; b.position.y = 0.2 * k; }
    if (k > 0 && v.model.vk) v.model.setVehicle(0);
  }

  // Kneel onto the tracks (or stand back up); a QuadVee conversion gets a bit of ceremony
  async animConvert(v, toVehicle, sp, convert) {
    const mdl = v.model;
    if (!mdl.wheels.length || (mdl.vk > 0.5) === toVehicle) return;
    v.animating = true;
    if (convert) { sfx('servo'); this.float(v, toVehicle ? 'VEHICLE MODE' : 'MECH MODE', 'info'); }
    const k0 = mdl.vk, k1 = toVehicle ? 1 : 0;
    await this.tween((convert ? 750 : 420) / sp, (k) => {
      const kk = k * k * (3 - 2 * k);
      mdl.setVehicle(k0 + (k1 - k0) * kk);
      if (convert) mdl.torso.rotation.y = Math.sin(k * Math.PI) * 0.6;
    });
    if (convert) { sfx('step', { gain: 1.2, rate: 0.6 }); this.spawn(mdl.root.position.clone(), { n: 8, color: '#8a7a66', size: 0.35, speed: 1.2, life: 0.7, normal: true, opacity: 0.4 }); }
    mdl.torso.rotation.y = 0;
    v.animating = false;
  }

  // a mech that was out of sight steps (or shoots) into view
  unfog(v, m) {
    if (!v || v.model.root.visible || !m || m.exited) return;
    if (!m.hidden) this.placeMech(v, m);
    v.model.root.visible = true;
    if (v.ghost) v.ghost.visible = false;
  }

  async animMove(v, e, sp) {
    const path = e.path;
    const root = v.model.root;
    if (!root.visible && !v.state.exited) { // coming out of the fog of war
      const p0 = hexWorld(path[0].x, path[0].y);
      root.position.set(p0.x, this.tileTop(path[0].x, path[0].y), p0.z); root.rotation.y = facingRot(path[0].f);
      root.visible = true; if (v.ghost) v.ghost.visible = false;
    }
    const tracked = e.mode === 'track' || e.mode === 'cruise' || e.mode === 'flank';
    if (v.model.wheels.length && e.mode !== 'jump' && e.mode !== 'stand') await this.animConvert(v, tracked, sp, false);
    v.animating = true;
    if (e.mode === 'jump') {
      const a = path[0], b = path[path.length - 1];
      const pa = hexWorld(a.x, a.y); pa.y = this.tileTop(a.x, a.y);
      const pb = hexWorld(b.x, b.y); pb.y = this.tileTop(b.x, b.y);
      const r0 = root.rotation.y, r1 = facingRot(b.f);
      let dr = ((r1 - r0 + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      sfx('jet', { pan: this.panOf(pa) });
      const height = 1.6 + pa.distanceTo(pb) * 0.25;
      this.focusHex(b.x, b.y);
      await this.tween(900 / sp, (k) => {
        const kk = k * k * (3 - 2 * k);
        root.position.lerpVectors(pa, pb, kk);
        root.position.y += Math.sin(k * Math.PI) * height;
        root.rotation.y = r0 + dr * kk;
        for (const j of v.model.jets) { const p = new THREE.Vector3(); j.getWorldPosition(p); this.spawn(p, { color: '#7fd0ff', size: 0.25, speed: 0.4, vel: new THREE.Vector3(0, -2.5, 0), life: 0.35, up: 0 }); }
        if (!v.model.jets.length && Math.random() < 0.6) this.spawn(root.position, { color: '#7fd0ff', size: 0.35, speed: 0.4, vel: new THREE.Vector3(0, -2.5, 0), life: 0.35 });
      });
      sfx('step', { gain: 1.6, rate: 0.7 });
      this.dust(pb.clone().setY(pb.y + 0.1), 12, 0.42);
    } else {
      const stepMs = (e.mode === 'run' || e.mode === 'flank' ? 170 : tracked ? 200 : 240) / sp;
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1], b = path[i];
        if (a.x === b.x && a.y === b.y) {
          const r0 = root.rotation.y, r1 = facingRot(b.f);
          const dr = ((r1 - r0 + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
          if (i === 1 || i === path.length - 1) sfx('servo');
          await this.tween(stepMs * 0.55, (k) => { root.rotation.y = r0 + dr * k; });
          continue;
        }
        const pa = hexWorld(a.x, a.y); pa.y = this.tileTop(a.x, a.y);
        const pb = hexWorld(b.x, b.y); pb.y = this.tileTop(b.x, b.y);
        const back = neighbor(a.x, a.y, a.f + 3);
        const reverse = back.x === b.x && back.y === b.y;
        this.focusHex(b.x, b.y);
        let lastK = 0;
        await this.tween(stepMs, (k) => {
          root.position.lerpVectors(pa, pb, k);
          if (tracked) {
            rollTracks(v.model, (reverse ? -1 : 1) * (k - lastK) * pa.distanceTo(pb));
            if (Math.floor(k * 5) !== Math.floor(lastK * 5)) this.treadMark(root.position, root.rotation.y, v.model.trackGauge, v.model.scale);
            lastK = k; return;
          }
          root.position.y += Math.sin(k * Math.PI) * 0.06;
          v.walk += (reverse ? -1 : 1) * 0.2;
          const sw = Math.sin(k * Math.PI * 2) * 0.55;
          v.model.legs.forEach((l) => { const g = sw * l.gait; l.hip.rotation.x = g; l.knee.rotation.x = l.rest + Math.max(0, -g) * 0.8; });
        });
        if (tracked) { sfx('servo', { gain: 0.35, pan: this.panOf(pb) }); this.dust(root.position, 2, 0.22 * v.model.scale); }
        else {
          // dust under the planted foot; heavier mechs kick up more
          const heavy = Math.min(1.6, 0.6 + v.state.tons / 70);
          this.dust(pb.clone().add(new THREE.Vector3(Math.sin(root.rotation.y + Math.PI / 2) * 0.18 * (i % 2 ? 1 : -1), 0.05, Math.cos(root.rotation.y + Math.PI / 2) * 0.18 * (i % 2 ? 1 : -1))), Math.round(2 + heavy * 2), 0.2 * heavy);
          // footsteps of mechs off the screen: full, quieter or muted (Settings > sound)
          const on = this.offSteps === 'on' || this.onScreenPos(pb, 0);
          if (on || this.offSteps !== 'off') sfx('step', { tons: v.state.tons, pan: this.panOf(pb), vol: on ? 1 : 0.35 });
        }
      }
      if (!tracked) v.model.legs.forEach((l) => { l.hip.rotation.x = 0; l.knee.rotation.x = l.rest; });
    }
    const last = path[path.length - 1];
    root.rotation.y = facingRot(last.f);
    v.animating = false;
  }

  aimAt(v, t) {
    if (!t) return;
    const a = v.model.root.position, b = t.model.root.position;
    const world = Math.atan2(b.x - a.x, b.z - a.z);
    let rel = world - v.model.root.rotation.y;
    rel = ((rel + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    v.wantYaw = v.free ? rel : Math.max(-1.1, Math.min(1.1, rel));
  }

  async animShot(v, t, e, state, sp) {
    if (!t) return;
    this.aimAt(v, t);
    v.model.torso.rotation.y = v.wantYaw;
    const W = WEAPONS[e.wt];
    const w = e.k === 'sshot' ? state.structures[e.sid].weapons[e.w] : e.k === 'ushot' ? (state.units[e.uid] || { weapons: [] }).weapons[e.w] : state.mechs[e.id].weapons[e.w];
    const wm = w && v.model.weaponMounts && v.model.weaponMounts[w.i];
    if (wm) { triggerWeaponAnim(wm); if (wm.anim && wm.anim.charge) await sleep(260 / sp); }
    if (v.free) await sleep(180 / sp); // turret swings round
    const from = wm ? wm.muzzle.getWorldPosition(new THREE.Vector3()) : this.muzzleWorld(v, w ? w.loc : 2);
    const to = e.hit ? this.bodyPoint(t) : this.bodyPoint(t, 2.2).setY(t.model.root.position.y + Math.random() * 0.4);
    const pan = this.panOf(from);
    const impact = (p, big = 0.5) => {
      if (e.hit) { this.explosion(p, big); sfx('hit', { pan, delay: 0 }); }
      else this.spawn(p, { n: 8, color: '#9c8a70', size: 0.35, speed: 1.4, life: 0.8, normal: true, opacity: 0.5 });
    };
    const dmg = e.hits.reduce((s, h) => s + h.dmg, 0);
    const MUZZLE = { laserS: ['#ff8a3c', 0.6], laserM: ['#ff4d9a', 0.75], laserL: ['#ff3b5c', 1], plasma: ['#7fc8ff', 1], ac: ['#ffc44a', 1.1], mg: ['#ffd27a', 0.55], lrm: ['#ffb36b', 0.8], srm: ['#ffb36b', 0.7] }[W.fx];
    if (MUZZLE) this.muzzleFlash(from, MUZZLE[0], MUZZLE[1]);
    switch (W.fx) {
      case 'laserS': case 'laserM': case 'laserL': {
        const size = W.fx === 'laserL' ? 1.6 : W.fx === 'laserM' ? 1.15 : 0.8;
        const color = W.fx === 'laserL' ? '#ff3b5c' : W.fx === 'laserM' ? '#ff4d9a' : '#ff8a3c';
        sfx('laser', { size, pan });
        if (W.fx === 'laserL') {
          // one long, thick beam after a short charge
          if (wm) this.spawn(from, { n: 6, color: '#ff8aa0', size: 0.25, speed: 0.4, life: 0.15 });
          await sleep(70 / sp);
          this.beam(from, to, color, 0.04, 0.5);
          impact(to, 0.6);
          await sleep(420 / sp);
        } else {
          // pulses: pew-pew (medium), pew-pew-pew (small)
          const n = W.fx === 'laserM' ? 2 : 3, gap = W.fx === 'laserM' ? 100 : 75;
          for (let i = 0; i < n; i++) {
            const tt = i ? to.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.15, (Math.random() - 0.5) * 0.15, (Math.random() - 0.5) * 0.15)) : to;
            this.beam(from, tt, color, 0.022 * size, 0.12);
            if (i === n - 1 || e.hit) impact(tt, 0.25 * size);
            await sleep(gap / sp);
          }
          await sleep(80 / sp);
        }
        break;
      }
      case 'plasma': {
        sfx('plasma', { pan });
        await this.projectile(from, to, { color: '#7fc8ff', size: 0.55, dur: 0.22 / sp });
        this.beam(from, to, '#5fb0ff', 0.03, 0.18);
        impact(to, 0.9);
        this.spawn(to, { n: 12, color: '#bfe6ff', size: 0.15, speed: 4, life: 0.4, grow: 0 });
        await sleep(200 / sp);
        break;
      }
      case 'ac': {
        const big = e.wt === 3 ? 1.4 : e.wt === 2 ? 1.1 : 0.8;
        sfx('cannon', { size: big, pan });
        this.spawn(from, { n: 6, color: '#ffd27a', size: 0.3 * big, speed: 1, life: 0.2 });
        await this.projectile(from, to, { color: '#ffe0a0', size: 0.18 * big, dur: 0.18 / sp });
        impact(to, 0.6 * big);
        await sleep(160 / sp);
        break;
      }
      case 'mg': {
        sfx('mg', { pan });
        for (let i = 0; i < 12; i++) { const tt = to.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.4)); this.projectile(from, tt, { color: '#ffe680', size: 0.1, dur: 0.12 / sp }); if (i % 3 === 0) this.spawn(from, { n: 2, color: '#ffd27a', size: 0.12, speed: 0.6, life: 0.08 }); await sleep(48 / sp); }
        if (e.hit) this.spawn(to, { n: 10, color: '#ffe08a', size: 0.1, speed: 3, life: 0.3, grow: 0 });
        await sleep(120 / sp);
        break;
      }
      case 'lrm': case 'srm': {
        const n = Math.min(8, e.wt >= 9 ? [2, 4, 6][e.wt - 9] : 5);
        const lrm = W.fx === 'lrm';
        sfx('rocket', { count: n, pan });
        const proms = [];
        for (let i = 0; i < n; i++) {
          const tt = (e.hit && i < (e.missiles || n) ? this.bodyPoint(t, 0.5) : this.bodyPoint(t, 2.5).setY(t.model.root.position.y));
          proms.push(this.projectile(from.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.2, 0, (Math.random() - 0.5) * 0.2)), tt, { color: '#ffb36b', size: 0.14, dur: (lrm ? 0.75 : 0.35) / sp, arc: lrm ? 2.2 : 0.3, trail: true })
            .then(() => { if (e.hit && i < (e.missiles || n)) this.explosion(tt, 0.35); else this.spawn(tt, { n: 5, color: '#9c8a70', size: 0.3, speed: 1, life: 0.6, normal: true, opacity: 0.5 }); }));
          await sleep(55 / sp);
        }
        await Promise.all(proms);
        if (e.hit) sfx('hit', { pan });
        break;
      }
      case 'flamer': {
        sfx('flamer', { pan });
        for (let i = 0; i < 18; i++) {
          const k = Math.random();
          const p = from.clone().lerp(to, k);
          this.spawn(p, { color: i % 2 ? '#ff7a1a' : '#ffd04a', size: 0.25 + k * 0.4, speed: 0.6, life: 0.4, vel: to.clone().sub(from).multiplyScalar(0.6) });
          await sleep(15 / sp);
        }
        await sleep(200 / sp);
        break;
      }
      default: await sleep(200 / sp);
    }
    if (e.hit) this.float(t, (e.missiles ? `${e.missiles}× ` : '') + dmg, 'dmg');
    else this.float(t, 'MISS', 'miss');
  }

  async animMelee(v, t, e, sp) {
    if (!t) return;
    this.aimAt(v, t);
    const root = v.model.root;
    const p0 = root.position.clone();
    const ram = e.kind === 'charge';
    const dir = t.model.root.position.clone().sub(p0).multiplyScalar(ram ? 0.55 : e.kind === 'push' ? 0.4 : 0.3);
    if (ram) { await this.tween(140 / sp, (k) => { root.position.copy(p0).addScaledVector(dir, -0.25 * k); }); sfx('step', { tons: v.state.tons, pan: this.panOf(p0) }); }
    await this.tween((ram ? 150 : 180) / sp, (k) => { root.position.copy(p0).addScaledVector(dir, ram ? -0.25 + 1.25 * k * k : k); });
    if (e.hit) {
      const p = this.bodyPoint(t, 0.2); this.explosion(p, ram ? 1.2 : e.kind === 'push' ? 0.3 : 0.7); sfx('melee');
      if (ram) sfx('boom', { size: 0.7, pan: this.panOf(p) });
      if (e.kind === 'hatchet') this.spawn(p, { n: 18, color: '#ffe08a', size: 0.12, speed: 5, life: 0.5, gravity: 9, grow: 0 });
      this.float(t, e.kind === 'push' ? 'PUSHED' : ram ? `${e.dmg} RAM` : String(e.dmg), e.kind === 'push' ? 'info' : 'dmg');
    }
    else { sfx('servo'); this.float(t, 'MISS', 'miss'); }
    await this.tween(220 / sp, (k) => { root.position.copy(p0).addScaledVector(dir, 1 - k); });
  }

  // Death from above: an arc up and down onto the target, a heavy impact, then back to its hex
  async animDFA(v, t, e, sp) {
    if (!t) return;
    this.aimAt(v, t);
    const root = v.model.root;
    const p0 = root.position.clone();
    const to = t.model.root.position.clone();
    const top = to.clone(); top.y += t.model.height * 0.75;
    const peak = Math.max(p0.y, top.y) + 3.2;
    sfx('jet', { pan: this.panOf(p0) });
    this.spawn(p0.clone().add(new THREE.Vector3(0, 0.3, 0)), { n: 14, color: '#ffb347', size: 0.35, speed: 1.2, life: 0.5, up: -0.4 });
    const land = e.hit ? top : to.clone().lerp(p0, 0.45);
    await this.tween(520 / sp, (k) => {
      const h = 4 * k * (1 - k);
      root.position.set(p0.x + (land.x - p0.x) * k, p0.y + (land.y - p0.y) * k + h * (peak - Math.max(p0.y, land.y)), p0.z + (land.z - p0.z) * k);
    });
    if (e.hit) {
      const p = this.bodyPoint(t, 0.2);
      this.explosion(p, 1.3); sfx('melee'); sfx('boom', { size: 0.8, pan: this.panOf(p) });
      this.spawn(to.clone().add(new THREE.Vector3(0, 0.2, 0)), { n: 18, color: '#8a7a66', size: 0.5, speed: 2.4, life: 1, normal: true, opacity: 0.5 });
      this.float(t, `${e.dmg} DFA`, 'dmg');
      const tr = t.model.root, t0 = tr.position.clone();
      await this.tween(160 / sp, (k) => { tr.position.y = t0.y - Math.sin(k * Math.PI) * 0.25; });
      tr.position.copy(t0);
      await this.tween(380 / sp, (k) => { root.position.set(land.x + (p0.x - land.x) * k, land.y + (p0.y - land.y) * k + 4 * k * (1 - k) * 1.2, land.z + (p0.z - land.z) * k); });
    } else {
      sfx('melee'); this.float(t, 'MISS', 'miss');
      this.dust(land.clone().add(new THREE.Vector3(0, 0.2, 0)), 16, 0.5);
      await this.tween(260 / sp, (k) => { root.position.lerpVectors(land, p0, k); });
    }
    root.position.copy(p0);
  }

  // The cockpit pod rockets clear, pops a parachute and drifts down beside the wreck
  async animEject(v, e, sp) {
    const head = v.model.root.position.clone(); head.y += v.model.height * 0.92;
    const pod = new THREE.Group();
    const shell = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.16, 4, 8), new THREE.MeshStandardMaterial({ color: '#c9ced3', metalness: 0.4, roughness: 0.5 }));
    pod.add(shell);
    const chute = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: e.ok ? '#ff8a3d' : '#c0c0c0', side: THREE.DoubleSide, roughness: 0.9 }));
    chute.position.y = 0.75; chute.scale.setScalar(0.01); pod.add(chute);
    const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0.1, 0), new THREE.Vector3(-0.38, 0.72, 0), new THREE.Vector3(0, 0.1, 0), new THREE.Vector3(0.38, 0.72, 0), new THREE.Vector3(0, 0.1, 0), new THREE.Vector3(0, 0.72, 0.38)]), new THREE.LineBasicMaterial({ color: '#dddddd' }));
    lines.visible = false; pod.add(lines);
    pod.position.copy(head);
    this.fxGroup.add(pod);
    sfx('jet', { pan: this.panOf(head) });
    this.float(v, e.killed ? 'PILOT LOST' : e.ok ? 'EJECTED' : 'HARD LANDING', e.killed ? 'kill' : e.ok ? 'info' : 'crit');
    const side = new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).normalize().multiplyScalar(1.2);
    const peak = head.clone().add(new THREE.Vector3(0, 3.2, 0)).addScaledVector(side, 0.4);
    await this.tween(420 / sp, (k) => {
      pod.position.lerpVectors(head, peak, 1 - (1 - k) * (1 - k));
      if (Math.random() < 0.7) this.spawn(pod.position.clone(), { n: 1, color: '#ffb347', size: 0.25, speed: 0.3, life: 0.4 });
      if (Math.random() < 0.5) this.spawn(pod.position.clone(), { n: 1, color: '#6b6b6b', size: 0.35, speed: 0.2, life: 1.2, normal: true, opacity: 0.5, grow: 2 });
    });
    lines.visible = true;
    const ground = v.model.root.position.clone().addScaledVector(side, e.ok ? 1.4 : 0.9); ground.y += 0.15;
    await this.tween((e.ok ? 900 : 500) / sp, (k) => {
      chute.scale.setScalar(Math.min(1, k * 4) * (e.ok ? 1 : 0.55));
      pod.position.lerpVectors(peak, ground, k);
      pod.rotation.z = Math.sin(k * 9) * 0.12;
    });
    await sleep(400 / sp);
    this.tween(500 / sp, (k) => { pod.scale.setScalar(1 - k); }).then(() => { this.fxGroup.remove(pod); });
  }

  // Reactor breach or ammo blast: fireball, a shockwave ring across the ground, debris
  async animBlast(e, sp) {
    if (!this.map) return;
    const c = hexWorld(e.x, e.y); c.y = this.tileTop(e.x, e.y) + 0.6;
    this.focusHex(e.x, e.y); await sleep(200 / sp);
    const big = e.r > 1 ? 3.2 : 1.8;
    this.explosion(c, big);
    this.spawn(c, { n: 30, color: '#fff2c0', size: 0.25, speed: 7 * (e.r > 1 ? 1.3 : 1), life: 0.7, gravity: 6, grow: 0 });
    this.spawn(c, { n: 14, color: '#2b2b2b', size: 1.4, speed: 1.2, life: 2.6, rise: 1.6, normal: true, opacity: 0.6, grow: 3 });
    sfx('boom', { size: e.r > 1 ? 2.4 : 1.6, pan: this.panOf(c) });
    const geo = new THREE.RingGeometry(0.8, 1, 48); geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: e.r > 1 ? '#bfe6ff' : '#ffc070', transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(geo, mat); ring.position.set(c.x, c.y - 0.45, c.z);
    this.fxGroup.add(ring);
    const reach = (e.r + 0.6) * 1.75;
    await this.tween(650 / sp, (k) => { ring.scale.setScalar(0.3 + k * reach); mat.opacity = 0.9 * (1 - k); });
    this.fxGroup.remove(ring); geo.dispose(); mat.dispose();
  }

  float(v, text, cls) {
    if (!this.onFloat) return;
    const p = v.model.root.position.clone(); p.y += v.model.height * 0.9;
    this.onFloat(text, p, cls);
  }
}

function critShort(code) {
  if (code <= 16) return WEAPONS[code].short + ' DESTROYED';
  if (code <= 28) return 'AMMO HIT';
  if (code <= 36) return 'ARM ACTUATOR';
  if (code <= 44) return 'LEG ACTUATOR';
  return { 45: 'LIFE SUPPORT', 46: 'SENSORS', 47: 'COCKPIT', 48: 'ENGINE HIT', 49: 'GYRO HIT', 50: 'JUMP JET', 51: 'HEAT SINK', 52: 'JUMP JET' }[code] || 'CRITICAL';
}

export { TERRAIN, toAxial, operational };
