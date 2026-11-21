import { execFile, spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BrowserExtensionPlatform } from "./types.ts";

const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

export function windowsBrowserExtensionPlatform(): BrowserExtensionPlatform {
  return {
    launch(browser, signal) {
      const names = {
        chrome: "chrome.exe",
        edge: "msedge.exe",
        brave: "brave.exe",
        chromium: "chrome.exe",
        firefox: "firefox.exe",
      } as const;
      return new Promise((resolve, reject) => {
        const query = (root: "HKCU" | "HKLM") =>
          new Promise<string | undefined>((done) =>
            execFile(
              "reg.exe",
              [
                "query",
                `${root}\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${names[browser]}`,
                "/ve",
              ],
              { signal, timeout: 3000, windowsHide: true },
              (error, stdout) =>
                done(error ? undefined : /REG_SZ\s+(.+)/i.exec(stdout)?.[1]?.trim()),
            ),
          );
        void (async () => {
          const exe = (await query("HKCU")) ?? (await query("HKLM"));
          if (!exe) {
            reject(new Error("browser_executable_missing"));
            return;
          }
          const child = spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: true });
          child.once("error", reject);
          child.once("spawn", () => {
            child.unref();
            resolve();
          });
        })().catch(reject);
      });
    },
    async createLauncher({ dataDir, executable, entry }) {
      const path = join(dataDir, "browser-extension", "native-host.cmd");
      await mkdir(dirname(path), { recursive: true });
      // %* keeps the browser's own arguments (origin and window handle) after our flag.
      const args = [
        quote(executable),
        ...(entry ? [quote(entry)] : []),
        "--pibot-browser-native-host",
      ];
      await writeFile(
        path,
        `@echo off\r\nset "PIBOT_DATA_DIR=${dataDir.replaceAll('"', "")}"\r\n${args.join(" ")} %*\r\n`,
      );
      return path;
    },
    removeLauncher: (path) => rm(path, { force: true }),
  };
}
