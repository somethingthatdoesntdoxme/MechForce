// Terrain dressing: animated water and lava, the sky dome, and small noise helpers used to
// give the hex tiles some natural variation. Kept apart from renderer.js so the battlefield
// look can be tuned in one place.
import * as THREE from 'three';
import { fromAxial } from '../core/hex.js';

// Stable pseudo-random number in [0, 1) for an integer-ish seed
export const rnd = (i) => { const x = Math.sin(i * 12.9898) * 43758.5453; return x - Math.floor(x); };

// Smooth value noise over hex coordinates: gives the map broad patches (drier ground, lusher
// grass, dirtier snow) rather than every tile flickering independently.
export function patchNoise(x, y, scale = 4.5, seed = 0) {
  const fx = x / scale, fy = y / scale;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  const h = (a, b) => rnd(a * 157.31 + b * 311.7 + seed * 71.9);
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const top = h(x0, y0) + (h(x0 + 1, y0) - h(x0, y0)) * sx;
  const bot = h(x0, y0 + 1) + (h(x0 + 1, y0 + 1) - h(x0, y0 + 1)) * sx;
  return top + (bot - top) * sy; // 0..1
}

// Which hex a world-space point falls in (pointy-top hexes of radius 1, offset rows)
export function hexAtPoint(px, pz) {
  const q = Math.sqrt(3) / 3 * px - pz / 3, r = 2 / 3 * pz;
  let rq = Math.round(q), rr = Math.round(r), rs = Math.round(-q - r);
  const dq = Math.abs(rq - q), dr = Math.abs(rr - r), ds = Math.abs(rs + q + r);
  if (dq > dr && dq > ds) rq = -rr - rs; else if (dr > ds) rr = -rq - rs;
  return fromAxial(rq, rr);
}

// Shared GLSL: cheap value noise
const NOISE = `
float mfHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float mfNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mfHash(i), mfHash(i + vec2(1.0, 0.0)), u.x), mix(mfHash(i + vec2(0.0, 1.0)), mfHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

// Water and lava surfaces. Both are a MeshStandardMaterial with a few lines patched in:
//  - water: rippling normals, foam along the shore (per-vertex `shore`), clearer shallows
//  - lava: slow-moving dark crust over a bright, pulsing melt
// `uniforms.uTime` is advanced by the renderer every frame.
export function liquidMaterial(theme, lava, uniforms) {
  const mat = new THREE.MeshStandardMaterial(lava
    ? { color: theme.water, roughness: 0.75, metalness: 0, emissive: new THREE.Color('#ff3c00'), emissiveIntensity: 1.35 }
    : { color: theme.water, transparent: true, opacity: 0.78, roughness: 0.32, metalness: 0.08, emissive: new THREE.Color('#0a2a3a'), emissiveIntensity: 0.3 });
  mat.customProgramCacheKey = () => (lava ? 'mf-lava' : 'mf-water');
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uniforms.uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float shore;\nvarying float vShore;\nvarying vec3 vWPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvShore = shore;\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying float vShore;\nvarying vec3 vWPos;\n' + NOISE);
    if (lava) {
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <color_fragment>', `#include <color_fragment>
  vec2 lp = vWPos.xz * 0.85;
  float lavaN = mfNoise(lp + vec2(uTime * 0.06, uTime * 0.04)) * 0.65 + mfNoise(lp * 2.3 - vec2(uTime * 0.09, 0.0)) * 0.35;
  // crust: cooler at the banks, cracked open in the middle
  float crust = smoothstep(0.5, 0.78, lavaN + vShore * 0.25);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.11, 0.06, 0.045), crust * 0.85);`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  float pulse = 0.88 + 0.12 * sin(uTime * 1.7 + vWPos.x * 0.6 + vWPos.z * 0.4);
  totalEmissiveRadiance *= mix(1.55, 0.12, crust) * pulse;`);
    } else {
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <color_fragment>', `#include <color_fragment>
  vec2 wp = vWPos.xz;
  // shallows near the bank are lighter and clearer, deep water darker
  diffuseColor.rgb *= mix(0.86, 1.18, vShore);
  float foamWave = 0.5 + 0.5 * sin(uTime * 1.6 + wp.x * 1.3 + wp.y * 1.1);
  float foam = smoothstep(0.72 - foamWave * 0.12, 0.98, vShore + (mfNoise(wp * 3.5 + uTime * 0.4) - 0.5) * 0.22);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.96, 1.0), foam * 0.6);
  diffuseColor.a = mix(diffuseColor.a * mix(1.0, 0.82, vShore), 0.95, foam * 0.7);`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
  {
    // gentle ripples: perturb the (world-up) surface normal, then back into view space
    float rx = sin(wp.x * 2.1 + uTime * 1.25) * 0.6 + sin(wp.y * 3.3 + wp.x * 0.7 - uTime * 1.6) * 0.4;
    float rz = cos(wp.y * 2.4 - uTime * 1.1) * 0.6 + cos(wp.x * 3.1 - wp.y * 0.9 + uTime * 1.45) * 0.4;
    vec3 nW = normalize(vec3(rx * 0.11, 1.0, rz * 0.11));
    normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
  }`);
    }
  };
  return mat;
}

// A big gradient dome behind everything: horizon colour (matching the fog, so distant ground
// melts into it) up to a deeper zenith.
export function skyDome(horizon, zenith) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { horizon: { value: new THREE.Color(horizon) }, zenith: { value: new THREE.Color(zenith) } },
    vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 horizon; uniform vec3 zenith; varying vec3 vDir;
      void main() { float k = smoothstep(-0.05, 0.6, vDir.y); gl_FragColor = vec4(mix(horizon, zenith, k), 1.0);
      #include <colorspace_fragment>
      }`,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(300, 32, 16), mat);
  dome.renderOrder = -10; dome.frustumCulled = false;
  return dome;
}
