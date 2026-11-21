// Which gaming handheld (if any) the desktop app is running on, from the firmware's DMI
// strings: /sys on Linux and SteamOS, the BIOS registry key on Windows. The profile tells the
// game the screen it is driving so it can pick a render resolution, frame cap and UI scale.
const fs = require('node:fs');

// match: every given field must match (case-insensitive regex). Newest/most specific first.
const HANDHELDS = [
  { id: 'deck-oled', name: 'Steam Deck OLED', short: 'Deck', match: { vendor: /valve/i, board: /^galileo$/i }, inches: 7.4, w: 1280, h: 800, hz: 90 },
  { id: 'deck', name: 'Steam Deck', short: 'Deck', match: { vendor: /valve/i, board: /^jupiter$/i }, inches: 7, w: 1280, h: 800, hz: 60 },
  { id: 'legion-go-s', name: 'Legion Go S', short: 'Go S', match: { vendor: /lenovo/i, family: /legion go s/i }, inches: 8, w: 1920, h: 1200, hz: 120 },
  { id: 'legion-go-s', name: 'Legion Go S', short: 'Go S', match: { vendor: /lenovo/i, product: /^83(L3|N6|Q2|Q3)$/i }, inches: 8, w: 1920, h: 1200, hz: 120 },
  { id: 'legion-go-2', name: 'Legion Go 2', short: 'Go 2', match: { vendor: /lenovo/i, family: /legion go 2/i }, inches: 8.8, w: 1920, h: 1200, hz: 144 },
  { id: 'legion-go-2', name: 'Legion Go 2', short: 'Go 2', match: { vendor: /lenovo/i, product: /^83N[01]$/i }, inches: 8.8, w: 1920, h: 1200, hz: 144 },
  { id: 'legion-go', name: 'Legion Go', short: 'Legion Go', match: { vendor: /lenovo/i, family: /legion go/i }, inches: 8.8, w: 2560, h: 1600, hz: 144 },
  { id: 'legion-go', name: 'Legion Go', short: 'Legion Go', match: { vendor: /lenovo/i, product: /^83E1$/i }, inches: 8.8, w: 2560, h: 1600, hz: 144 },
  { id: 'xbox-ally', name: 'ROG Xbox Ally', short: 'Ally', match: { vendor: /asus/i, board: /^RC73/i }, inches: 7, w: 1920, h: 1080, hz: 120 },
  { id: 'rog-ally-x', name: 'ROG Ally X', short: 'Ally X', match: { vendor: /asus/i, board: /^RC72/i }, inches: 7, w: 1920, h: 1080, hz: 120 },
  { id: 'rog-ally', name: 'ROG Ally', short: 'Ally', match: { vendor: /asus/i, board: /^RC71/i }, inches: 7, w: 1920, h: 1080, hz: 120 },
  { id: 'msi-claw', name: 'MSI Claw', short: 'Claw', match: { vendor: /micro-star|msi/i, product: /claw/i }, inches: 8, w: 1920, h: 1200, hz: 120 },
  { id: 'zotac-zone', name: 'Zotac Zone', short: 'Zone', match: { vendor: /zotac/i, product: /zone/i }, inches: 7, w: 1920, h: 1080, hz: 120 },
  { id: 'ayaneo', name: 'AYANEO', short: 'AYANEO', match: { vendor: /ayaneo|ayadevice/i }, inches: 7, w: 1920, h: 1080, hz: 60 },
  { id: 'onexplayer', name: 'OneXPlayer', short: 'OneX', match: { vendor: /one-?netbook|onexplayer/i }, inches: 8, w: 1920, h: 1200, hz: 60 },
  { id: 'gpd', name: 'GPD Win', short: 'GPD', match: { vendor: /^gpd$/i }, inches: 6, w: 1920, h: 1080, hz: 60 },
];

function matchHandheld(dmi) {
  for (const h of HANDHELDS) {
    if (Object.entries(h.match).every(([k, re]) => re.test(String(dmi[k] || '').trim()))) {
      const { match, ...rest } = h;
      return { ...rest, family: h.id.startsWith('deck') ? 'deck' : 'pc' };
    }
  }
  return null;
}

function readDmi() {
  if (process.platform === 'linux') {
    const rd = (f) => { try { return fs.readFileSync('/sys/devices/virtual/dmi/id/' + f, 'utf8').trim(); } catch { return ''; } };
    return { vendor: rd('sys_vendor'), product: rd('product_name'), family: rd('product_family') || rd('product_version'), board: rd('board_name') };
  }
  if (process.platform === 'win32') {
    try {
      const out = require('node:child_process').execFileSync('reg', ['query', 'HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS'], { encoding: 'utf8', timeout: 2000, windowsHide: true });
      const get = (k) => (out.match(new RegExp('^\\s*' + k + '\\s+REG_SZ\\s+(.*)$', 'mi')) || [])[1] || '';
      return { vendor: get('SystemManufacturer'), product: get('SystemProductName'), family: get('SystemFamily') || get('SystemVersion'), board: get('BaseBoardProduct') };
    } catch { return {}; }
  }
  return {};
}

// SteamOS game mode (and Bazzite/ChimeraOS) run games inside gamescope
function inGamescope(env = process.env) {
  return !!(env.GAMESCOPE_WAYLAND_DISPLAY || env.SteamGamepadUI || env.SteamDeck === '1' || /gamescope/i.test(env.XDG_CURRENT_DESKTOP || ''));
}
function isSteamOS() {
  try { return /steamos/i.test(fs.readFileSync('/etc/os-release', 'utf8')); } catch { return false; }
}

function detect(env = process.env) {
  let handheld = null;
  if (env.MF_HANDHELD) {
    // force a profile: MF_HANDHELD=legion-go-s, or =1 for a generic 1280x800 handheld
    handheld = HANDHELDS.map(({ match, ...h }) => ({ ...h, family: h.id.startsWith('deck') ? 'deck' : 'pc' })).find((h) => h.id === env.MF_HANDHELD)
      || { id: 'generic', name: 'Handheld', short: 'Handheld', inches: 7, w: 1280, h: 800, hz: 60, family: 'pc' };
  } else if (env.MF_HANDHELD !== '0') {
    const dmi = readDmi();
    handheld = matchHandheld(dmi);
    if (!handheld && env.SteamDeck === '1') handheld = { id: 'deck', name: 'Steam Deck', short: 'Deck', inches: 7, w: 1280, h: 800, hz: 60, family: 'deck' };
  }
  const gamescope = process.platform === 'linux' && inGamescope(env);
  return { handheld, gamescope, steamos: process.platform === 'linux' && isSteamOS() };
}

module.exports = { detect, matchHandheld, inGamescope, HANDHELDS };
