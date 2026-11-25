// electron-builder afterPack hook (Linux): put a small launcher in front of the Electron
// binary. Since Electron 38, Electron picks native Wayland on its own in a Wayland session,
// and the display system has to be chosen on the command line, before any of our code runs.
// On SteamOS (desktop and game mode) native Wayland + Vulkan makes Chromium quit at start-up,
// so the launcher starts us on X11 (Xwayland), as Electron 33 did.
//   MF_OZONE=wayland|auto|x11 overrides it.
// Steam shortcuts, the .desktop entry and the AppImage all run `mechforce`, so they all get it.
const fs = require('fs');
const path = require('path');

module.exports = async (context) => {
  if (context.electronPlatformName !== 'linux') return;
  const name = context.packager.executableName; // "mechforce"
  const dir = context.appOutDir;
  const bin = path.join(dir, name);
  const real = path.join(dir, name + '-bin');
  fs.renameSync(bin, real);
  fs.writeFileSync(bin, `#!/bin/sh
# MechForce launcher: start on X11 unless MF_OZONE says otherwise (see build/after-pack.cjs)
here="$(dirname "$(readlink -f "$0")")"
exec "$here/${name}-bin" --ozone-platform="\${MF_OZONE:-x11}" "$@"
`, { mode: 0o755 });
};
