// Handheld detection from DMI strings (electron/handheld.cjs)
const { matchHandheld, inGamescope } = require('../electron/handheld.cjs');
let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; console.log('FAIL', msg); } };
const cases = [
  [{ vendor: 'LENOVO', product: '83L3', family: 'Legion Go S 8APU1', board: 'LNVNB161216' }, 'legion-go-s'],
  [{ vendor: 'LENOVO', product: '83N6', family: '', board: '' }, 'legion-go-s'],
  [{ vendor: 'LENOVO', product: '83E1', family: 'Legion Go 8APU1', board: 'LNVNB161216' }, 'legion-go'],
  [{ vendor: 'LENOVO', product: '83N0', family: 'Legion Go 2 8ASP2', board: '' }, 'legion-go-2'],
  [{ vendor: 'Valve', product: 'Jupiter', board: 'Jupiter' }, 'deck'],
  [{ vendor: 'Valve', product: 'Galileo', board: 'Galileo' }, 'deck-oled'],
  [{ vendor: 'ASUSTeK COMPUTER INC.', product: 'ROG Ally RC71L_RC71L', board: 'RC71L' }, 'rog-ally'],
  [{ vendor: 'ASUSTeK COMPUTER INC.', product: 'ROG Ally X RC72LA', board: 'RC72LA' }, 'rog-ally-x'],
  [{ vendor: 'Micro-Star International Co., Ltd.', product: 'Claw A1M', board: 'MS-1T41' }, 'msi-claw'],
  [{ vendor: 'AYANEO', product: 'AYANEO 2S', board: 'AB05-Mendocino' }, 'ayaneo'],
  [{ vendor: 'LENOVO', product: '21KC', family: 'ThinkPad T14 Gen 5', board: '21KC' }, null],
  [{ vendor: 'Dell Inc.', product: 'XPS 13 9340' }, null],
  [{}, null],
];
for (const [dmi, want] of cases) {
  const h = matchHandheld(dmi);
  ok((h ? h.id : null) === want, `${JSON.stringify(dmi)} -> ${h && h.id}, wanted ${want}`);
}
const gs = matchHandheld(cases[0][0]);
ok(gs.w === 1920 && gs.h === 1200 && gs.hz === 120 && gs.family === 'pc' && gs.short === 'Go S', 'Go S profile');
ok(matchHandheld(cases[4][0]).family === 'deck', 'Deck family');
ok(inGamescope({ GAMESCOPE_WAYLAND_DISPLAY: 'gamescope-0' }) && inGamescope({ XDG_CURRENT_DESKTOP: 'gamescope' }) && !inGamescope({ XDG_CURRENT_DESKTOP: 'KDE' }), 'gamescope session');
console.log(fails ? `${fails} FAILED` : `handheld detection ok (${cases.length} devices)`);
process.exit(fails ? 1 : 0);
