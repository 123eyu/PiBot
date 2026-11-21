import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

interface LoginItemOptions {
  platform: NodeJS.Platform;
  homedir: string;
  env: Readonly<NodeJS.ProcessEnv>;
  executable: string;
  args: string[];
  /** Unpackaged run (`electron.exe <app path>`), e.g. `pnpm dev` or a PIBOT_DATA_DIR test run. */
  dev?: boolean;
}

/**
 * Windows accepts any executable in HKCU\...\Run, so an unpackaged run would silently register
 * `electron.exe <app path>` as "electron.app.Electron" when enabled and start the dev
 * build at every login without its PIBOT_DATA_DIR. macOS refuses unsigned dev builds on its own.
 */
function devOnWindows(options: LoginItemOptions) {
  return options.platform === "win32" && options.dev === true;
}

function loginItemFile(options: LoginItemOptions): string {
  return join(
    options.env.XDG_CONFIG_HOME || join(options.homedir, ".config"),
    "autostart",
    "pi-bot.desktop",
  );
}

export async function getLoginItem(
  options: LoginItemOptions & {
    getNative(settings: { path: string; args: string[] }): { openAtLogin: boolean };
  },
): Promise<boolean> {
  if (devOnWindows(options)) return false;
  if (options.platform === "darwin" || options.platform === "win32")
    return options.getNative({ path: options.executable, args: options.args }).openAtLogin;
  if (options.platform !== "linux") throw new Error("Login items are unsupported on this platform");
  try {
    const content = await readFile(loginItemFile(options), "utf8");
    return (
      !/^Hidden\s*=\s*true\s*$/im.test(content) &&
      !/^X-GNOME-Autostart-enabled\s*=\s*false\s*$/im.test(content)
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export function autostartFile(executable: string, args: readonly string[] = []): string {
  // Desktop Entry Exec has its own quoting rules; never use shell quoting here.
  const quote = (value: string) => {
    if (/[\r\n\0]/.test(value)) throw new TypeError("Invalid autostart argument");
    const quoted = `"${value.replaceAll("%", "%%").replace(/[\\"`$]/g, "\\$&")}"`;
    // Desktop-entry string escaping is decoded before the Exec quoting rules.
    return quoted.replaceAll("\\", "\\\\");
  };
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Pi Bot",
    `Exec=${[executable, ...args].map(quote).join(" ")}`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

export async function setLoginItem(
  options: LoginItemOptions & {
    openAtLogin: boolean;
    setNative(settings: { openAtLogin: boolean; path: string; args: string[] }): void;
  },
): Promise<void> {
  if (devOnWindows(options)) {
    if (options.openAtLogin)
      throw new Error("Login items are unsupported for unpackaged Windows runs");
    return;
  }
  if (options.platform === "darwin" || options.platform === "win32") {
    options.setNative({
      openAtLogin: options.openAtLogin,
      path: options.executable,
      args: options.args,
    });
    return;
  }
  if (options.platform !== "linux") throw new Error("Login items are unsupported on this platform");
  const file = loginItemFile(options);
  const directory = dirname(file);
  if (!options.openAtLogin) {
    await rm(file, { force: true });
    return;
  }
  const content = autostartFile(options.executable, options.args);
  await mkdir(directory, { recursive: true });
  await writeFile(file, content, { mode: 0o600 });
}
