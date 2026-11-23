// Computer opponent. Returns one command at a time for the active AI side.
import { maxRounds, objectiveStructure, convoyUnits, meleeDamage, chargeSelfDamage, shoveHex, hatchetProblem, MELEE_KINDS } from './rules.js';
import { neighbor } from './hex.js';
import { WEAPONS, TERRAIN } from './data.js';
import { computeReach, canEndAt, toHit, availableMechs, operational, canAct, lineOfSight, inArc, missionOf,
  expectedDamage, dissipation, totalArmor, maxArmor, tileOf, toHitUnit, activeSide, moveModes, moveKind, availMP, canConvert, MOVE_HEAT, visibleTo, toHitStructure, envHeat, smokeAt, isBurning, defenceTargets, dfaDamage, dfaSelfDamage, pilotingMods, elevOf } from './rules.js';
import { STRUCTS, AI_LEVELS, bodyOf } from './data.js';
import { distance, relBearing, angleBetween, normAngle, DIR_ANGLE } from './hex.js';
import { chance, nextRand } from './rng.js';

function moveMod(mode, hexes) {
  let v = hexes >= 18 ? 5 : hexes >= 10 ? 4 : hexes >= 7 ? 3 : hexes >= 5 ? 2 : hexes >= 3 ? 1 : 0;
  return v + (mode === 'jump' ? 1 : 0);
}

// With fog of war the computer only knows about enemies its team can see
const knownEnemies = (st, m) => st.mechs.filter((e) => operational(e) && e.team !== m.team && visibleTo(st, m.team, e));
// ...and otherwise hunts towards where it last saw one, or the middle of the map
function searchGoal(st, m) {
  const mem = st.seen && st.seen[m.team];
  let best = null;
  if (mem) for (const [id, g] of Object.entries(mem)) {
    const e = st.mechs[id];
    if (!e || !operational(e)) continue;
    const score = g.r * 10 - distance(m.x, m.y, g.x, g.y);
    if (!best || score > best.score) best = { x: g.x, y: g.y, score };
  }
  if (best && distance(m.x, m.y, best.x, best.y) > 1) return { x: best.x, y: best.y, weight: 1.2 };
  return { x: st.map.w >> 1, y: st.map.h >> 1, weight: 0.8 };
}

function goalFor(st, m) {
  const mis = missionOf(st);
  const { w } = st.map;
  const it = st.item;
  if (mis.id === 'crossing' && m.team === 0) return { x: w - 1, y: m.y, weight: 3, edge: 'E' };
  if (it && !it.gone) {
    if (it.carrier === m.id) {
      if (mis.homeExit) return { x: m.team === 0 ? 0 : w - 1, y: m.y, weight: 4, edge: m.team === 0 ? 'W' : 'E' };
      if (mis.id === 'pepsi') return { x: m.team === 0 ? w - 1 : 0, y: m.y, weight: 4, edge: m.team === 0 ? 'E' : 'W' };
      if (mis.spy) return { x: w - 1, y: m.y, weight: 4, edge: 'E' };
    }
    if (it.carrier === null && (mis.carriers.includes(m.team) || (mis.spy && m.team === 0))) return { x: it.x, y: it.y, weight: 2.5 };
    if (it.carrier !== null) {
      const c = st.mechs[it.carrier];
      if (c && c.team !== m.team) return { x: c.x, y: c.y, weight: 1.5, hunt: c.id };
      if (c && c.team === m.team) return { x: c.x, y: c.y, weight: 0.6 };
    }
  }
  // a command post to knock down or stand guard over
  if (mis.fort) {
    const s = objectiveStructure(st);
    if (s && !s.dead) return m.team === mis.fort.team ? { x: s.x, y: s.y, weight: 0.5, range: 4 } : { x: s.x, y: s.y, weight: 1.6, range: 3 };
  }
  // a convoy: the escort stays just ahead of the lead hauler, the raiders go for the nearest one
  if (mis.convoy) {
    const live = convoyUnits(st).filter((u) => !u.dead && !u.immobile);
    if (live.length) {
      if (m.team === mis.convoy.team) {
        const lead = live.reduce((a, b) => (b.x > a.x ? b : a));
        return { x: Math.min(w - 2, lead.x + 2), y: lead.y, weight: 0.6, range: 3 };
      }
      const near = live.reduce((a, b) => (distance(m.x, m.y, b.x, b.y) < distance(m.x, m.y, a.x, a.y) ? b : a));
      return { x: near.x, y: near.y, weight: 1.5, range: 3 };
    }
  }
  if (mis.scout && m.team === 0) {
    if (m.scouted) return { x: 0, y: m.y, weight: 4, edge: 'W' };
    return { x: Math.floor(w * 2 / 3) + 1, y: m.y, weight: 2.5 };
  }
  return null;
}

function heatBudget(st, m, moveHeat) {
  return dissipation(st, m) - m.heat - moveHeat + 4;
}

function bestVolley(opts, budget) {
  // opts: [{w, ed, heat}] choose greedily by damage per heat within budget
  const free = opts.filter((o) => o.heat <= 0);
  const hot = opts.filter((o) => o.heat > 0).sort((a, b) => b.ed / b.heat - a.ed / a.heat);
  let dmg = free.reduce((s, o) => s + o.ed, 0), heat = 0;
  const picked = free.slice();
  for (const o of hot) { if (heat + o.heat <= budget) { heat += o.heat; dmg += o.ed; picked.push(o); } }
  return { dmg, heat, picked };
}

// How the computer plays this battle, and how hard it presses as the clock runs down:
// 0 early on, rising to 1 by the last round
const levelOf = (st) => AI_LEVELS[st.aiLevel] || AI_LEVELS.normal;
function pressureOf(st) {
  const L = levelOf(st);
  // with no round limit, commanders still get impatient as if it were the mission's own
  const limit = maxRounds(st) || missionOf(st).rounds || 30;
  return Math.max(0, Math.min(1, (st.round - L.pressureFrom) / Math.max(4, limit - L.pressureFrom)));
}

// short/medium range band edges per weapon, kept off the game state (which goes over the wire)
const BANDS = new WeakMap();
const ATK_MOD = { stand: 0, walk: 1, run: 2, jump: 3 };
function evalPositions(st, m) {
  const L = levelOf(st);
  const pressure = pressureOf(st);
  const enemies = knownEnemies(st, m);
  const allies = st.mechs.filter((e) => operational(e) && e.team === m.team && e.id !== m.id);
  const goal = goalFor(st, m) || (st.fog && !enemies.length ? searchGoal(st, m) : null);
  const { w, h } = st.map;
  const avgRange = m.weapons.filter((x) => x.ok).reduce((s, x) => s + x.rng, 0) / Math.max(1, m.weapons.filter((x) => x.ok).length) || 6;
  const optRange = Math.max(1, Math.min(9, Math.round(avgRange * 0.5)));
  const hexCache = new Map();
  const hexInfo = (x, y) => {
    const key = y * w + x;
    if (hexCache.has(key)) return hexCache.get(key);
    const info = enemies.map((e) => {
      const los = lineOfSight(st, x, y, e.x, e.y);
      return { e, los, d: distance(x, y, e.x, e.y), ang: angleBetween(x, y, e.x, e.y) };
    });
    hexCache.set(key, info);
    return info;
  };
  const myWoods = (x, y) => TERRAIN[tileOf(st, x, y)].woods + (TERRAIN[tileOf(st, x, y)].depth === 1 ? 1 : 0) + smokeAt(st, x, y);
  // enemy gun emplacements and bunkers: they shoot back at the end of the round, and are
  // worth knocking out when there's nothing better to shoot
  const forts = (st.structures || []).filter((s) => !s.dead && s.team !== m.team && (s.team >= 0 || STRUCTS[s.kind].slots));
  const armedForts = forts.filter((s) => s.team >= 0 && s.weapons.some((w) => w.ok && w.ammo !== 0));
  const fortInfo = new Map();
  const fortAt = (x, y) => {
    const key = y * w + x;
    if (!fortInfo.has(key)) fortInfo.set(key, armedForts.map((s) => ({ s, los: lineOfSight(st, s.x, s.y, x, y), d: distance(x, y, s.x, s.y) })));
    return fortInfo.get(key);
  };
  // mission targets that aren't mechs: the enemy command post, or the convoy's haulers
  const mis = missionOf(st);
  const prizes = [];
  if (mis.fort && m.team !== mis.fort.team) { const s = objectiveStructure(st); if (s && !s.dead) prizes.push({ x: s.x, y: s.y, mod: -4 }); }
  if (mis.convoy && m.team !== mis.convoy.team) for (const u of convoyUnits(st)) if (!u.dead && !u.immobile && (!st.fog || visibleTo(st, m.team, u))) prizes.push({ x: u.x, y: u.y, mod: 1 });
  const prizeInfo = new Map();
  const prizeAt = (x, y) => {
    const key = y * w + x;
    if (!prizeInfo.has(key)) prizeInfo.set(key, prizes.map((p) => ({ p, los: lineOfSight(st, x, y, p.x, p.y), d: distance(x, y, p.x, p.y) })));
    return prizeInfo.get(key);
  };
  const best = { score: -1e9, cmd: null };
  const fragile = totalArmor(m) / maxArmor(m);
  // QuadVees also weigh converting: vehicle mode makes no movement heat and can't fall,
  // BattleMech mode can kick and jump
  const plans = moveModes(m).map((mode) => ({ mode, convert: false }));
  if (canConvert(st, m)) for (const mode of moveModes(m)) if (mode !== 'jump') plans.push({ mode, convert: true });
  let nearest = 99;
  for (const e of enemies) nearest = Math.min(nearest, distance(m.x, m.y, e.x, e.y));
  // Speed: everything below that doesn't depend on the hex or facing being scored is worked
  // out once here, and per-hex values once per hex rather than once per facing. The scoring
  // itself is unchanged, so the AI picks exactly the same moves as before, just faster.
  const dissNow = dissipation(st, m);
  const budgetFor = (mvHeat) => dissNow - m.heat - mvHeat + 4; // = heatBudget(st, m, mvHeat)
  let pilotSum = null;
  const pilotMods = () => (pilotSum ?? (pilotSum = pilotingMods(m).reduce((a2, [, v2]) => a2 + v2, 0)));
  const foe = new Map(enemies.map((e) => [e, {
    mm: moveModE(e), woods: TERRAIN[tileOf(st, e.x, e.y)].woods, elev: elevOf(st, e.x, e.y),
    armor: totalArmor(e), armorMax: maxArmor(e), act: canAct(e),
  }]));
  const myGuns = m.weapons.filter((wp) => wp.ok && wp.ammo !== 0);
  const bands = (wp) => { let b = BANDS.get(wp); if (!b) BANDS.set(wp, b = [Math.ceil(wp.rng / 3), Math.ceil(wp.rng * 2 / 3)]); return b; };
  // Weapon arcs from a bearing worked out once per target and facing. This is rules.inArc
  // with the bearing passed in (relBearing is trig-heavy and this runs millions of times):
  // keep the two in step.
  const arms = bodyOf(m) !== 'quad';
  const arcOK = (loc, rel) => {
    if (loc === -1) return true;
    if (arms && loc === 4) return rel >= -120.01 && rel <= 60.01;
    if (arms && loc === 5) return rel >= -60.01 && rel <= 120.01;
    return Math.abs(rel) <= 60.01;
  };
  for (const { mode, convert } of plans) {
    const reach = computeReach(st, m, mode, { convert });
    if (reach.mp < 0 || (reach.mp <= 0 && mode !== moveModes(m)[0])) continue;
    const moveHeatBase = mode === 'jump' ? 3 : MOVE_HEAT[convert ? moveKind(mode) : mode] || 0;
    let convBias = 0;
    if (convert) {
      const toVehicle = m.vmode !== 'vehicle';
      convBias = toVehicle ? (m.heat >= 6 ? 2 : 0) + (nearest > 9 ? 1.5 : -1) : (nearest <= 3 ? 2 : -0.5);
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let anyF = false;
      for (let f = 0; f < 6; f++) if (isFinite(reach.cost[(y * w + x) * 6 + f])) { anyF = true; break; }
      if (!anyF || !canEndAt(st, m, x, y, reach)) continue;
      const info = hexInfo(x, y);
      // the same for every facing at this hex
      const here = { ...m, x, y };
      const myW = myWoods(x, y), envH = envHeat(st, here), dissHere = dissipation(st, here);
      const burning = isBurning(st, x, y), elevHere = elevOf(st, x, y);
      const fortList = fortAt(x, y), prizeList = prizes.length ? prizeAt(x, y) : [];
      const returnFire = new Map(); // enemy -> Map(defMod -> expected damage)
      const gunsAt = new Map();     // enemy -> Map(atkMod -> { cands, volleys })
      const gd = goal ? (goal.edge ? (goal.edge === 'E' ? w - 1 - x : x) : Math.max(0, distance(x, y, goal.x, goal.y) - (goal.range || 0))) : 0;
      let nd = 99;
      for (const it of info) nd = Math.min(nd, it.d);
      let ad = 99;
      for (const a of allies) ad = Math.min(ad, distance(x, y, a.x, a.y));
      // Threat at this hex
      for (let f = 0; f < 6; f++) {
        const k = (y * w + x) * 6 + f;
        if (!isFinite(reach.cost[k])) continue;
        const hexes = reach.steps[k];
        const stand = hexes === 0 && x === m.x && y === m.y;
        const md = stand ? 'stand' : mode;
        const mvHeat = stand ? (f === m.f ? 0 : 1) : (mode === 'jump' ? Math.max(3, hexes) : moveHeatBase);
        const atkMod = ATK_MOD[moveKind(md)];
        const defMod = moveMod(md, hexes);
        let offense = 0, threat = 0;
        for (const it of info) {
          const e = it.e;
          if (!it.los.ok) continue;
          const fe = foe.get(e);
          // Our hit chances on this enemy from this hex don't depend on facing, only which guns
          // bear does: work out the candidates once per hex (and move type), then filter by arc.
          let byAtk = gunsAt.get(e);
          if (!byAtk) gunsAt.set(e, byAtk = new Map());
          let g = byAtk.get(atkMod);
          if (!g) {
            const cands = [];
            for (const wp of myGuns) {
              if (it.d > wp.rng) continue;
              const [s, mr] = bands(wp);
              let tn = m.pilot.gun + (it.d <= s ? 0 : it.d <= mr ? 2 : 4) + atkMod + fe.mm + it.los.woods + fe.woods;
              if (wp.minr && it.d <= wp.minr) tn += wp.minr - it.d + 1;
              if (e.shutdown || e.pilot.ko) tn -= 4;
              tn += Math.floor(m.heat >= 8 ? 1 : 0);
              const p = chance(tn);
              if (p > 0) cands.push({ w: wp, ed: expectedDamage(wp, p), heat: wp.heat });
            }
            byAtk.set(atkMod, g = { cands, volleys: new Map() });
          }
          const rel = normAngle(it.ang - DIR_ANGLE[f]); // = relBearing(x, y, f, e.x, e.y)
          // which candidate guns bear, as a bitmask (the volley for a mask + heat budget is cached)
          let mask = 0;
          for (let i = 0; i < g.cands.length; i++) if (arcOK(g.cands[i].w.loc, rel)) mask += 2 ** i;
          if (mode === 'jump' && !stand && it.d === 1 && !e.hidden && m.tons >= 40 && (e.prone || fe.elev <= elevHere)) {
            const p = chance(m.pilot.pil + 3 + fe.mm + (e.prone ? -2 : 0) + pilotMods());
            const dmg = dfaDamage(m);
            const dfaVal = p * dmg * (fe.armor < dmg * 2.5 ? 1.6 : 1) - p * dfaSelfDamage(m) * 0.25 - (1 - p) * dmg * 0.35;
            offense = Math.max(offense, dfaVal);
          }
          // up close, a kick (or a hatchet) may beat the guns
          if (it.d === 1 && !e.hidden && mode !== 'jump' && Math.abs(rel) <= 60.01 && Math.abs(fe.elev - elevHere) <= 1) {
            const base = m.pilot.pil + atkMod + fe.mm + (e.prone ? -3 : 0) + (e.shutdown || e.pilot.ko ? -4 : 0);
            const big = Math.ceil(m.tons / 5);
            const mv = Math.max(chance(base - 2) * big * 0.85, m.hatchet !== undefined && !hatchetProblem(m) ? chance(base - 1) * big : 0);
            offense = Math.max(offense, mv * (fe.armor < big * 2.5 ? 1.5 : 1));
          }
          if ((mode === 'walk' || mode === 'run') && !stand && hexes >= 2 && it.d === 1 && !e.hidden && !e.prone && m.tons >= e.tons) {
            const ah = neighbor(x, y, f);
            if (ah.x === e.x && ah.y === e.y && Math.abs(fe.elev - elevHere) <= 1) {
              const p = chance(m.pilot.pil + (m.pilot.pil - e.pilot.pil) + atkMod + fe.mm);
              const dmg = Math.ceil(m.tons / 10) * hexes;
              offense = Math.max(offense, (p * dmg * (fe.armor < dmg * 2.5 ? 1.5 : 1) - p * (chargeSelfDamage(e) * 0.5 + 2)) * 0.8);
            }
          }
          if (mask) {
            const budget = budgetFor(mvHeat), vk = mask * 8192 + budget; // budget is a small integer
            let v = g.volleys.get(vk);
            if (!v) g.volleys.set(vk, v = bestVolley(g.cands.filter((_, i) => Math.floor(mask / 2 ** i) % 2), budget));
            // close in on the enemy closest to falling, so the lance converges on one target
            const finish = (fe.armor < v.dmg * 2.5 ? 1.6 : 1) * (1 + (1 - fe.armor / fe.armorMax) * L.focus * 0.6);
            const carrierBonus = st.item && st.item.carrier === e.id ? 1.5 : 1;
            offense = Math.max(offense, v.dmg * finish * carrierBonus);
          }
          // enemy shooting back
          if (fe.act) {
            // depends only on how far we moved (defMod), not which way we face: once per hex
            let byMod = returnFire.get(e);
            if (!byMod) returnFire.set(e, byMod = new Map());
            let ed = byMod.get(defMod);
            if (ed === undefined) {
              ed = 0;
              for (const wp of e.weapons) {
                if (!wp.ok || wp.ammo === 0 || it.d > wp.rng) continue;
                const [s, mr] = bands(wp);
                const tn = e.pilot.gun + (it.d <= s ? 0 : it.d <= mr ? 2 : 4) + 1 + defMod + it.los.woods + myW;
                ed += expectedDamage(wp, chance(tn));
              }
              byMod.set(defMod, ed);
            }
            const absRel = Math.abs(rel);
            const rearF = absRel >= 120 ? 1.6 : absRel > 60 ? 1.2 : 1;
            threat += ed * rearF * (e.activated ? 0.6 : 1);
          }
        }
        // incoming fire from enemy defences at the end of the round
        for (const fi of fortList) {
          if (!fi.los.ok) continue;
          for (const wp of fi.s.weapons) {
            if (!wp.ok || wp.ammo === 0 || fi.d > wp.rng) continue;
            const s2 = Math.ceil(wp.rng / 3), mr = Math.ceil(wp.rng * 2 / 3);
            const tn = 4 + (fi.d <= s2 ? 0 : fi.d <= mr ? 2 : 4) + defMod + fi.los.woods + myW + (wp.minr && fi.d <= wp.minr ? wp.minr - fi.d + 1 : 0);
            threat += expectedDamage(wp, chance(tn));
          }
          // ...and we could shoot it
          if (offense < 3) {
            const opts = [];
            for (const wp of m.weapons) if (wp.ok && wp.ammo !== 0 && fi.d <= wp.rng && inArc(m, wp.loc, fi.s.x, fi.s.y, { x, y, f })) {
              const s2 = Math.ceil(wp.rng / 3), mr = Math.ceil(wp.rng * 2 / 3);
              const p = chance(m.pilot.gun + (fi.d <= s2 ? 0 : fi.d <= mr ? 2 : 4) + atkMod - 4 + fi.los.woods);
              if (p > 0) opts.push({ w: wp, ed: expectedDamage(wp, p), heat: wp.heat });
            }
            if (opts.length) offense = Math.max(offense, bestVolley(opts, budgetFor(mvHeat)).dmg * 0.55);
          }
        }
        for (const pi of prizeList) {
          if (!pi.los.ok || pi.d < 1) continue;
          const opts = [];
          for (const wp of m.weapons) if (wp.ok && wp.ammo !== 0 && pi.d <= wp.rng && inArc(m, wp.loc, pi.p.x, pi.p.y, { x, y, f })) {
            const s2 = Math.ceil(wp.rng / 3), mr = Math.ceil(wp.rng * 2 / 3);
            const p = chance(m.pilot.gun + (pi.d <= s2 ? 0 : pi.d <= mr ? 2 : 4) + atkMod + pi.p.mod + pi.los.woods + (wp.minr && pi.d <= wp.minr ? wp.minr - pi.d + 1 : 0));
            if (p > 0) opts.push({ w: wp, ed: expectedDamage(wp, p), heat: wp.heat });
          }
          if (opts.length) offense = Math.max(offense, bestVolley(opts, budgetFor(mvHeat)).dmg * 1.3);
        }
        // the ground itself: fire, magma, climate (envH, worked out above for this hex)
        // caution falls as the clock runs down, so battles end with a decision
        let score = offense * 1.2 - threat * (0.35 + (1 - fragile) * 0.5) * L.caution * (1 - pressure * 0.5) + convBias - Math.max(0, envH) * 1.6 - (burning ? 4 : 0);
        if (goal) {
          score -= gd * goal.weight;
          if (gd === 0 && !goal.range) score += 30;
        } else if (enemies.length) {
          score -= Math.abs(nd - optRange) * 0.8;
          // late in the battle, close in on the nearest enemy rather than trading shots at range
          score -= nd * pressure * 0.7;
          // nobody in sight: don't sit behind a hill, find a firing line
          if (offense === 0) score -= 1.5 + nd * 0.15;
        }
        // stay near friends, avoid deep water, prefer high ground
        if (allies.length) {
          if (ad > 5) score -= (ad - 5) * 0.3;
        }
        score += st.map.e[y * w + x] * 0.4;
        if (m.heat + mvHeat + envH - dissHere > 8) score -= (m.heat + mvHeat + envH - dissHere - 8) * 1.5;
        score += nextRand({ rng: (x * 73856093) ^ (y * 19349663) ^ (f * 83492791) ^ st.seq }) * L.noise;
        if (score > best.score) best.score = score, best.cmd = { type: 'move', id: m.id, x, y, f, mode, ...(convert ? { convert: true } : {}) };
      }
    }
  }
  return best.cmd;
}
function moveModE(e) { return moveMod(moveKind(e.lastMove.mode), e.lastMove.hexes) + (e.prone ? 1 : 0); }

function chooseAttack(st, m) {
  const L = levelOf(st);
  const enemies = knownEnemies(st, m);
  let best = { v: 0, cmd: null };
  const cands = [];
  const budget = dissipation(st, m) - m.heat - (st.act ? st.act.heatGen : 0) + 5;
  for (const e of enemies) {
    const opts = [];
    for (const wp of m.weapons) {
      const th = toHit(st, m, e, wp);
      if (!th.ok || th.p <= 0.03) continue;
      opts.push({ w: wp, ed: expectedDamage(wp, th.p), heat: wp.heat });
    }
    if (opts.length) {
      const v0 = bestVolley(opts, budget);
      // a target this volley (or a hot one) could finish is worth running hot for
      const killable = totalArmor(e) < Math.max(25, v0.dmg * 1.6);
      const v = killable ? bestVolley(opts, budget + 6) : v0;
      // focus fire: pilots finish what their lancemates started, more so the better they are
      const hurt = 1 - totalArmor(e) / maxArmor(e);
      let val = v.dmg * (killable ? 1.5 : 1) * (st.item && st.item.carrier === e.id ? 1.6 : 1) * (1 + hurt * L.focus * 1.6);
      if (v.picked.length) cands.push({ v: val, cmd: { type: 'attack', id: m.id, target: e.id, weapons: v.picked.map((o) => o.w.i) } });
      if (v.picked.length && val > best.v) best = { v: val, cmd: { type: 'attack', id: m.id, target: e.id, weapons: v.picked.map((o) => o.w.i) } };
    }
    for (const kind of MELEE_KINDS) {
      const th = toHit(st, m, e, null, { kind });
      if (!th.ok) continue;
      let dmg = meleeDamage(m, kind);
      // a push is only worth it for what's behind the target: a long drop, or at least water
      if (kind === 'push') { const to = shoveHex(st, e, m.f); dmg = to.drop >= 2 ? Math.ceil(e.tons / 10) * (to.drop + 1) + 3 : (TERRAIN[tileOf(st, to.x, to.y)].depth ? 4 : 2); }
      // death from above hurts the attacker too: its legs on a hit, a nasty fall on a miss.
      // A charge costs armour as well, and both mechs may go down
      const risk = kind === 'dfa' ? th.p * dfaSelfDamage(m) * 0.25 + (1 - th.p) * dmg * 0.35 : kind === 'charge' ? th.p * (chargeSelfDamage(e) * 0.5 + 2) : 0;
      // the same focus-fire pull as shooting, so a pilot doesn't shoot a wreck it could stamp on
      const focusM = 1 + (1 - totalArmor(e) / maxArmor(e)) * L.focus * 1.6;
      const val = th.p * dmg * (kind === 'kick' ? 0.85 : 1) * (kind === 'dfa' && totalArmor(e) < dmg * 2.5 ? 1.6 : 1) * focusM - risk;
      if (val > best.v) best = { v: val, cmd: { type: 'melee', id: m.id, target: e.id, kind } };
    }
  }
  // infantry and vehicles shooting at us: worth a volley when no mech is a better target
  for (const u of (st.units || [])) {
    if (u.dead || u.hidden || u.x < 0 || u.team === m.team || (u.convoy && u.immobile)) continue;
    if (st.fog && !visibleTo(st, m.team ?? m.side, u)) continue;
    const opts = [];
    for (const wp of m.weapons) {
      const th = toHitUnit(st, m, u, wp);
      if (!th.ok || th.p <= 0.05) continue;
      // what the weapon really does to this kind of unit
      const W = WEAPONS[wp.t];
      const per = u.inf ? (wp.t === 4 ? 7 : wp.t === 15 ? 10.5 : W.kind === 'm' ? Math.ceil(expectedDamage(wp, 1) / 5) : Math.ceil(wp.dmg / 10)) * (TERRAIN[tileOf(st, u.x, u.y)].woods ? 1 : 2) : expectedDamage(wp, 1);
      opts.push({ w: wp, ed: per * th.p, heat: wp.heat });
    }
    if (!opts.length) continue;
    const v = bestVolley(opts, budget);
    const left = u.inf ? u.troops : u.armor + u.struct;
    const threat = u.weapons.some((w) => w.ok && w.ammo !== 0) && distance(m.x, m.y, u.x, u.y) <= Math.max(...u.weapons.map((w) => w.rng)) + 2;
    // a convoy's haulers are the whole point of the mission
    const val = (u.inf ? v.dmg / left * 25 : v.dmg) * (u.convoy ? 1.5 : threat ? 0.7 : 0.35) * (left <= v.dmg * 1.3 ? 1.5 : 1);
    if (v.picked.length && val > best.v) best = { v: val, cmd: { type: 'attack', id: m.id, unit: u.id, weapons: v.picked.map((o) => o.w.i) } };
  }
  // enemy emplacements: worth a volley when no mech is a better target
  for (const s of (st.structures || [])) {
    if (s.dead || s.team === m.team || (s.team < 0 && !STRUCTS[s.kind].slots)) continue;
    const opts = [];
    for (const wp of m.weapons) { const th = toHitStructure(st, m, s, wp); if (th.ok && th.p > 0.05) opts.push({ w: wp, ed: expectedDamage(wp, th.p), heat: wp.heat }); }
    if (!opts.length) continue;
    const v = bestVolley(opts, budget);
    const armed = s.team >= 0 && s.weapons.some((w) => w.ok && w.ammo !== 0);
    const val = v.dmg * (s.obj ? 1.3 : armed ? (s.cf <= v.dmg * 1.5 ? 0.9 : 0.6) : 0.15);
    if (v.picked.length && val > best.v) best = { v: val, cmd: { type: 'attack', id: m.id, structure: s.id, weapons: v.picked.map((o) => o.w.i) } };
  }
  // green pilots don't always pick the best shot
  if (L.slip && cands.length > 1 && best.cmd && best.cmd.target !== undefined && nextRand({ rng: (m.id * 7919) ^ st.seq ^ 0x5bd1e995 }) < L.slip) {
    cands.sort((a, b) => b.v - a.v);
    return cands[1].cmd;
  }
  return best.cmd || { type: 'end', id: m.id };
}
void defenceTargets;

// A computer pilot gives up a mech that can no longer fight: no working weapon and either
// crippled legs or a badly hurt pilot. With enemies crowding in and no friends nearby, a
// heavy mech's pilot may take them along with a self-destruct instead.
function abandonShip(st, m) {
  if (m.pilot.ko) return null;
  const armed = m.weapons.some((w) => w.ok && w.ammo !== 0);
  const legs = legsDown(m);
  const hurt = m.pilot.hits >= 4;
  if (armed || !(legs || hurt)) return null;
  const close = st.mechs.filter((e) => operational(e) && !e.hidden && e.x >= 0 && distance(m.x, m.y, e.x, e.y) <= 2);
  const foes = close.filter((e) => (e.team ?? e.side) !== (m.team ?? m.side)).length;
  const friends = close.filter((e) => e !== m && (e.team ?? e.side) === (m.team ?? m.side)).length;
  if (foes >= 1 && !friends && m.tons >= 50 && m.engineHits < 3) return { type: 'selfdestruct', id: m.id };
  return { type: 'eject', id: m.id };
}
const legsDown = (m) => m.locGone.some((g, l) => g && (l >= 6)) && (m.body === 'quad' ? m.locGone.filter((g, l) => g && l >= 4).length >= 2 : true);

export function aiNextCommand(st) {
  const side = activeSide(st);
  if (side < 0) return null;
  if (!st.act) {
    const av = availableMechs(st, side);
    if (!av.length) return null;
    // slow mechs commit first, fast ones keep their options open
    const speed = (x) => availMP(x, moveModes(x)[0]);
    av.sort((a, b) => speed(a) - speed(b) || a.id - b.id);
    const m = av[0];
    return abandonShip(st, m) || evalPositions(st, m) || { type: 'end', id: m.id };
  }
  const m = st.mechs[st.act.id];
  if (st.act.phase === 'move') return evalPositions(st, m) || { type: 'end', id: m.id };
  return chooseAttack(st, m);
}
