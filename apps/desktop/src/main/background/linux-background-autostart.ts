import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { IndependentBackgroundState } from "@pibot/protocol/background";
import { autostartFile } from "../window/login-item.ts";

type Management = IndependentBackgroundState["management"];

/**
 * Linux starts the background owner at sign-in through an XDG autostart entry, the same
 * mechanism the desktop's own open-at-login uses (no systemd user unit: desktop sessions start
 * autostart entries with the graphical session, which the owner needs for its keyring and
 * notifications). A separate file per data directory, so the window's login item stays its own.
 * Not yet accepted on a real Linux sign-in.
 */
export function createLinuxBackgroundAutostart(options: {
  label: string;
  home: string;
  /** XDG_CONFIG_HOME when set to an absolute path; otherwise ~/.config. */
  configHome?: string;
  executable: string;
  packaged: boolean;
  loginItemsEnabled: boolean;
}) {
  const directory = join(
    options.configHome && isAbsolute(options.configHome)
      ? options.configHome
      : join(options.home, ".config"),
    "autostart",
  );
  const file = join(directory, `${options.label}.desktop`);
  const unavailable = (reason: Management["reason"]): Management => ({
    kind: "xdg-autostart",
    available: false,
    registered: null,
    enabled: null,
    reason,
  });
  const gate = () => {
    if (!options.packaged) throw new Error("background_management_unpackaged");
    if (!options.loginItemsEnabled) throw new Error("background_management_data_dir");
  };
  async function query(): Promise<Management> {
    if (!options.packaged) return unavailable("unpackaged");
    if (!options.loginItemsEnabled) return unavailable("data_dir");
    try {
      const info = await lstat(file);
      // Only our own regular file counts; a link here was not written by this owner.
      if (!info.isFile() || info.isSymbolicLink()) return unavailable("query_failed");
      const content = await readFile(file, "utf8");
      const enabled =
        !/^Hidden\s*=\s*true\s*$/im.test(content) &&
        !/^X-GNOME-Autostart-enabled\s*=\s*false\s*$/im.test(content);
      return {
        kind: "xdg-autostart",
        available: true,
        registered: true,
        enabled,
        reason: "available",
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return {
          kind: "xdg-autostart",
          available: true,
          registered: false,
          enabled: false,
          reason: "available",
        };
      return unavailable("query_failed");
    }
  }
  async function register(signal: AbortSignal) {
    gate();
    signal.throwIfAborted();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      // "wx": never write through a link or file someone else placed at the temporary name.
      await writeFile(temporary, autostartFile(options.executable, ["--pibot-background"]), {
        mode: 0o600,
        flag: "wx",
      });
      signal.throwIfAborted();
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
    const current = await query();
    if (!current.registered || !current.enabled)
      throw new Error("background_registration_unconfirmed");
  }
  async function unregister(signal: AbortSignal) {
    gate();
    signal.throwIfAborted();
    await rm(file, { force: true });
  }
  return { query, register, unregister, disableLogin: unregister };
}
