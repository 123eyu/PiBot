import { spawn } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BrowserExtensionPlatform } from "./types.ts";

const shell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function unixBrowserExtensionPlatform(): BrowserExtensionPlatform {
  return {
    launch(browser, signal) {
      if (process.platform === "darwin") {
        const bundles = {
          chrome: "com.google.Chrome",
          edge: "com.microsoft.Edge",
          brave: "com.brave.Browser",
          chromium: "org.chromium.Chromium",
          firefox: "org.mozilla.firefox",
        } as const;
        return run("open", ["-g", "-b", bundles[browser]], signal);
      }
      const commands = {
        chrome: "google-chrome",
        edge: "microsoft-edge",
        brave: "brave-browser",
        chromium: "chromium",
        firefox: "firefox",
      } as const;
      return run(commands[browser], [], signal);
    },
    async createLauncher({ dataDir, executable, entry }) {
      const path = join(dataDir, "browser-extension", "native-host.sh");
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const args = [
        shell(executable),
        ...(entry ? [shell(entry)] : []),
        "--pibot-browser-native-host",
      ];
      await writeFile(
        path,
        `#!/bin/sh\nPIBOT_DATA_DIR=${shell(dataDir)} exec ${args.join(" ")} "$@"\n`,
        { mode: 0o700 },
      );
      await chmod(path, 0o700);
      return path;
    },
    removeLauncher: (path) => rm(path, { force: true }),
  };
}

function run(file: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const child = spawn(file, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
