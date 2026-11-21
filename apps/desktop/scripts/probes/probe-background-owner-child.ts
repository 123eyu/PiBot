// Entry for one isolated actual owner factory exercise, with only Electron surfaces replaced.
import { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import type { Logger } from "@pibot/observability";
import { createRedactor } from "@pibot/secrets";
import { startBackgroundOwner } from "../../src/main/background/background-owner.ts";
import { app, ownerProbe } from "./probe-background-owner-electron.ts";

const directory = process.argv[2] as string;
const scenario = process.argv[3] as string;
ownerProbe.scenario = scenario;
let release: () => void = () => {};
const delayed = new Promise<void>((resolve) => {
  release = resolve;
});
process.on("message", (value: { command: string }) => {
  if (value.command === "release") release();
  if (value.command === "quit") app.quit();
});
const chmod = fs.chmod,
  link = fs.link,
  rename = fs.rename,
  unlink = fs.unlink;
if (scenario === "socket-stop" || scenario === "socket-fail" || scenario === "socket-release-fail")
  fs.chmod = async (path, mode) => {
    if (path === join(directory, "background-runtime", "owner.sock")) {
      process.send?.({ paused: "socketPrivate" });
      await delayed;
      if (scenario === "socket-fail") throw new Error("private socket permission failure");
    }
    return chmod(path, mode);
  };
if (scenario === "reserve-os-quit")
  fs.link = async (from, to) => {
    await link(from, to);
    if (to === join(directory, "background-runtime", "owner.json")) {
      process.send?.({ paused: "reserve-published" });
      await delayed;
    }
  };
if (scenario === "spawn-stop")
  fs.rename = async (from, to) => {
    if (to === join(directory, "background-runtime", "owner.json")) {
      process.send?.({ paused: "utility-publication" });
      await delayed;
    }
    return rename(from, to);
  };
if (scenario === "socket-release-fail") {
  let failed = false;
  fs.unlink = async (path) => {
    if (path === join(directory, "background-runtime", "owner.lock") && !failed) {
      failed = true;
      throw new Error("private own claim release failure");
    }
    return unlink(path);
  };
}
syncBuiltinESMExports();
const logger = {
  info() {},
  warn(message: string) {
    process.send?.({ warning: message });
  },
  error(message: string) {
    process.send?.({ error: message });
  },
} as Logger;
try {
  await startBackgroundOwner({
    dataDir: directory,
    outputDir: directory,
    resourcesDir: directory,
    version: "synthetic-v1",
    dev: true,
    originalEnv:
      scenario === "init-fail-child"
        ? { PIBOT_DATA_DIR: directory, PIBOT_ROUTINE_TEST_DIR: directory }
        : {},
    logger,
    redactor: createRedactor(),
  });
  process.send?.({ initialized: true });
} catch {
  process.send?.({ startupFailed: true });
  // Failure cleanup normally already requested app.quit. Keep a bounded failure signal
  // if a retained unknown writer prevents quit, rather than deleting its claim.
}
