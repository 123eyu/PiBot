import { chmod, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

// AppImage's AppRun and tarball users both enter here, before Chromium can abort on userns.
export const linuxLauncher = `#!/bin/sh
set -eu
PIBOT_LAUNCH_DIR=$(CDPATH= cd -- "$(dirname -- "$(readlink -f -- "$0")")" && pwd)
# The doctor has no renderer: keep it usable without DISPLAY and without creating an owner.
for PIBOT_LAUNCH_ARG in "$@"; do
  if [ "$PIBOT_LAUNCH_ARG" = "--sandbox-doctor" ]; then
    exec "$PIBOT_LAUNCH_DIR/resources/bin/node" "$PIBOT_LAUNCH_DIR/resources/app.asar.unpacked/out/main/sandbox-doctor.js"
  fi
done
# The check runs on the bundled helper Node: Pi Bot's own executable has RunAsNode off.
PIBOT_APP_BINARY="$PIBOT_LAUNCH_DIR/pi-bot-bin" "$PIBOT_LAUNCH_DIR/resources/bin/node" "$PIBOT_LAUNCH_DIR/resources/app.asar.unpacked/out/main/linux-sandbox-check.js" "$@" &
PIBOT_CHECK_PID=$!
trap 'kill -TERM "$PIBOT_CHECK_PID" 2>/dev/null || :; wait "$PIBOT_CHECK_PID" 2>/dev/null || :; exit 1' INT TERM HUP
if wait "$PIBOT_CHECK_PID"; then
  trap - INT TERM HUP
else
  exit "$?"
fi
unset ELECTRON_RUN_AS_NODE
exec "$PIBOT_LAUNCH_DIR/pi-bot-bin" --disable-setuid-sandbox "$@"
`;

// Builder 26.15.3 writes AppRun before copying appOutDir over the stage. Supplying our own
// AppRun replaces its separate unshare heuristic, which otherwise adds --no-sandbox at runtime.
export const appRun = `#!/bin/sh
set -eu
APPDIR=$(CDPATH= cd -- "$(dirname -- "$(readlink -f -- "$0")")" && pwd)
export APPDIR
export PATH="$APPDIR:$APPDIR/usr/sbin\${PATH:+:$PATH}"
export XDG_DATA_DIRS="$APPDIR/usr/share:\${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
export LD_LIBRARY_PATH="$APPDIR/usr/lib\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export GSETTINGS_SCHEMA_DIR="$APPDIR/usr/share/glib-2.0/schemas"
if [ -z "\${APPIMAGE:-}" ]; then APPIMAGE="$APPDIR/AppRun"; export APPIMAGE; fi
if [ -n "\${APPIMAGE_EXIT_AFTER_INSTALL:-}" ]; then exit 0; fi
exec "$APPDIR/pi-bot" "$@"
`;

/** @param {import("app-builder-lib").AfterPackContext} context */
export default async function installLinuxLauncher(context) {
  if (context.electronPlatformName !== "linux") return;
  const executable = join(context.appOutDir, "pi-bot");
  await rename(executable, join(context.appOutDir, "pi-bot-bin"));
  await writeFile(executable, linuxLauncher, { mode: 0o755 });
  await chmod(executable, 0o755);
  await writeFile(join(context.appOutDir, "AppRun"), appRun, { mode: 0o755 });
}
