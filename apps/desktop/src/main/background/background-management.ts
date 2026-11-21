import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { IndependentBackgroundState } from "@pibot/protocol";
import { createLinuxBackgroundAutostart } from "./linux-background-autostart.ts";
import { createWindowsBackgroundTask } from "./windows-background-task.ts";

// electron-builder.yml appId. Without it macOS lists the login item under the signing
// certificate's name instead of Pi Bot (maintainers 2026-10-31).
const MAC_BUNDLE_ID = "app.pibot.desktop";

type Management = IndependentBackgroundState["management"];
type Command = (
  file: string,
  args: string[],
  signal: AbortSignal,
) => Promise<{ code: number; stdout: string }>;
export const managementCommand: Command = (file, args, signal) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        signal,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        },
      },
      (error, stdout) => {
        if (error && typeof error.code !== "number") {
          reject(new Error("background_manager_unavailable"));
          return;
        }
        resolve({ code: error ? Number(error.code) : 0, stdout });
      },
    );
  });
const xml = (value: string) =>
  value.replace(
    /[<>&"']/g,
    (character) =>
      ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[
        character
      ] as string,
  );

export function createBackgroundManagement(options: {
  platform: NodeJS.Platform;
  packaged: boolean;
  loginItemsEnabled?: boolean;
  home: string;
  dataDir: string;
  executable: string;
  command?: Command;
  systemRoot?: string;
  /** Linux XDG_CONFIG_HOME. */
  configHome?: string;
}) {
  const command = options.command ?? managementCommand;
  const suffix = createHash("sha256").update(options.dataDir).digest("hex").slice(0, 16);
  const label = `org.pibot.background.${suffix}`;
  if (options.platform === "win32")
    return createWindowsBackgroundTask({
      label,
      executable: options.executable,
      systemRoot: options.systemRoot,
      packaged: options.packaged,
      loginItemsEnabled: options.loginItemsEnabled === true,
    });
  if (options.platform === "linux")
    return createLinuxBackgroundAutostart({
      label,
      home: options.home,
      configHome: options.configHome,
      executable: options.executable,
      packaged: options.packaged,
      loginItemsEnabled: options.loginItemsEnabled === true,
    });
  const uid = process.getuid?.();
  const domain = `gui/${uid}`;
  const kind: Management["kind"] = options.platform === "darwin" ? "launchd" : "systemd-user";
  const path =
    options.platform === "darwin"
      ? join(options.home, "Library", "LaunchAgents", `${label}.plist`)
      : join(options.home, ".config", "systemd", "user", `${label}.service`);
  const run = async (file: string, args: string[], signal: AbortSignal) => {
    const result = await command(file, args, signal);
    if (result.code !== 0) throw new Error("background_manager_failed");
    return result.stdout;
  };
  const gate = () => {
    if (!options.packaged) throw new Error("background_management_unpackaged");
    if (!options.loginItemsEnabled) throw new Error("background_management_data_dir");
    // OS login/session/ACL/keyring behavior needs host acceptance before enabling these platforms.
    if (options.platform !== "darwin" || uid === undefined)
      throw new Error("background_management_platform_unverified");
  };
  async function query(): Promise<Management> {
    if (!options.packaged)
      return { kind, available: false, registered: null, enabled: null, reason: "unpackaged" };
    if (!options.loginItemsEnabled)
      return {
        kind,
        available: false,
        registered: null,
        enabled: null,
        reason: "data_dir",
      };
    if (options.platform !== "darwin" || uid === undefined)
      return {
        kind,
        available: false,
        registered: null,
        enabled: null,
        reason: "platform_unverified",
      };
    try {
      const result = await command(
        "/bin/launchctl",
        ["print", `${domain}/${label}`],
        AbortSignal.timeout(10_000),
      );
      if (result.code === 0) {
        const disabled = await command(
          "/bin/launchctl",
          ["print-disabled", domain],
          AbortSignal.timeout(10_000),
        );
        if (disabled.code !== 0)
          return {
            kind,
            available: false,
            registered: true,
            enabled: null,
            reason: "query_failed",
          };
        let installed = false;
        try {
          await readFile(path, "utf8");
          installed = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const escaped = label.replaceAll(".", "\\.");
        const enabled =
          installed && !new RegExp(`"${escaped}"\\s*=>\\s*true`).test(disabled.stdout);
        return { kind, available: true, registered: true, enabled, reason: "available" };
      }
      if (result.code !== 113)
        return {
          kind,
          available: false,
          registered: null,
          enabled: null,
          reason: "query_failed",
        };
      // Only a missing job permits fallback; listing the whole domain can exceed the output bound.
      const manager = await command(
        "/bin/launchctl",
        ["print-disabled", domain],
        AbortSignal.timeout(10_000),
      );
      return {
        kind,
        available: manager.code === 0,
        registered: manager.code === 0 ? false : null,
        enabled: manager.code === 0 ? false : null,
        reason: manager.code === 0 ? "available" : "manager_unavailable",
      };
    } catch {
      return { kind, available: false, registered: null, enabled: null, reason: "query_failed" };
    }
  }
  async function unregister(signal: AbortSignal) {
    gate();
    const current = await query();
    if (!current.available) throw new Error("background_manager_unavailable");
    if (options.platform === "darwin") {
      if (current.registered)
        await run("/bin/launchctl", ["bootout", `${domain}/${label}`], signal);
      await run("/bin/launchctl", ["disable", `${domain}/${label}`], signal);
    } else {
      await run("systemctl", ["--user", "disable", "--now", `${label}.service`], signal);
    }
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  async function register(signal: AbortSignal) {
    gate();
    const before = await query();
    if (!before.available) throw new Error("background_manager_unavailable");
    let previous: string | undefined;
    try {
      previous = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const args = [options.executable, "--pibot-background"];
    const contents =
      options.platform === "darwin"
        ? `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array><key>AssociatedBundleIdentifiers</key><array><string>${MAC_BUNDLE_ID}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><false/></dict></plist>`
        : `[Unit]\nDescription=Pi Bot background\n[Service]\nExecStart="${options.executable.replaceAll('"', '\\"')}" --pibot-background\nRestart=no\n[Install]\nWantedBy=default.target\n`;
    await writeFile(path, contents, { mode: 0o600 });
    try {
      if (options.platform === "darwin") {
        await run("/bin/launchctl", ["enable", `${domain}/${label}`], signal);
        if (!before.registered) await run("/bin/launchctl", ["bootstrap", domain, path], signal);
      } else {
        await run("systemctl", ["--user", "daemon-reload"], signal);
        await run("systemctl", ["--user", "enable", `${label}.service`], signal);
      }
      const current = await query();
      if (!current.registered) throw new Error("background_registration_unconfirmed");
    } catch (error) {
      if (previous !== undefined) await writeFile(path, previous, { mode: 0o600 });
      else await unlink(path);
      throw error;
    }
  }
  async function disableLogin(signal: AbortSignal) {
    gate();
    await run("/bin/launchctl", ["disable", `${domain}/${label}`], signal);
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { query, register, unregister, disableLogin };
}
