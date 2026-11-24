// The host's lobby settings are checked: unknown or junk values fall back to defaults and the
// game still starts and plays.
import './seed.mjs';
import { Room } from '../src/core/room.js';
import { THEMES, MAP_SIZES, MISSIONS } from '../src/core/data.js';
import { aiNextCommand } from '../src/core/ai.js';
import { applyCommand, activeSide } from '../src/core/rules.js';
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const msgs = [];
const room = new Room({ local: true, aiDelay: 0, send: (id, m) => msgs.push(m) });
const host = room.join({ name: 'Host', platform: 'pc' });
const junk = [
  { theme: 'urban', mapSize: 'XXL', mission: 'nope', teamMode: 42, sides: 'lots', seed: { a: 1 }, tonnage: 'heavy', lanceSize: -3, aiLevel: 'god', roundLimit: 7, defences: [], forces: null },
  { theme: null, mapSize: 5, mission: { id: 'generic' }, sides: 99, seed: 'x'.repeat(5000) },
];
for (const s of junk) {
  room.handle(host, { t: 'settings', settings: s });
  const st = room.settings;
  ok(THEMES.some((t) => t.id === st.theme), `theme ${JSON.stringify(s.theme)} -> ${st.theme}`);
  ok(MAP_SIZES.some((m) => m.id === st.mapSize), `map size ${JSON.stringify(s.mapSize)} -> ${st.mapSize}`);
  ok(MISSIONS.some((m) => m.id === st.mission), `mission ${JSON.stringify(s.mission)} -> ${st.mission}`);
  ok(['ffa', 'teams'].includes(st.teamMode) && Number.isInteger(st.sides) && typeof st.seed === 'string' && st.seed.length <= 40, `team mode ${st.teamMode}, sides ${st.sides}, seed length ${st.seed.length}`);
}
// and it still plays: AI on both sides, run to the end
room.handle(host, { t: 'slot', side: 0, ctrl: 'ai' });
room.handle(host, { t: 'slot', side: 1, ctrl: 'ai' });
room.handle(host, { t: 'start' });
const g = room.game;
ok(g && g.map.theme === room.settings.theme, 'game started with the cleaned-up settings');
let n = 0;
while (g && !g.over && n++ < 4000) { const c = aiNextCommand(g); const r = applyCommand(g, activeSide(g), c); if (!r.ok) applyCommand(g, activeSide(g), { type: 'end', id: c.id }); }
ok(g && g.over, `and played to the end (round ${g && g.round})`);
room.dispose();
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
console.log('all passed');
