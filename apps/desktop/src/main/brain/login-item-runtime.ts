/*
 * Open-at-login: the queued, serialized write of the OS login item plus the value the tray and the
 * brain child are told about. The queue lives here so `brain-host.ts` only awaits it on stop.
 */
import { homedir } from "node:os";
import type { Logger } from "@pibot/observability";
import { app } from "electron";
import { getLoginItem, setLoginItem } from "../window/login-item.ts";
import { createLoginItemSync } from "../window/login-item-scope.ts";

export function createLoginItemRuntime(options: {
  dev: boolean;
  originalEnv: Readonly<NodeJS.ProcessEnv>;
  logger: Logger;
  onLoginItem(openAtLogin: boolean): void;
  /** Publish the actual value; the caller only sends it while a brain child is ready. */
  publish(openAtLogin: boolean): void;
}) {
  const loginOptions: Omit<Parameters<typeof setLoginItem>[0], "openAtLogin"> &
    Pick<Parameters<typeof getLoginItem>[0], "getNative"> = {
    platform: process.platform,
    homedir: homedir(),
    env: options.originalEnv,
    executable: process.execPath,
    args: options.dev ? [app.getAppPath()] : [],
    dev: options.dev,
    setNative: (settings) => app.setLoginItemSettings(settings),
    getNative: (settings) => app.getLoginItemSettings(settings),
  };
  let actual: boolean | undefined;
  let revision = 0;
  let completed = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const sync = (value: boolean) => {
    actual = value;
    options.onLoginItem(value);
    options.publish(value);
  };
  // The tray always follows the last settled value; only what the child is told waits for the
  // newest request, so a superseded write still leaves the real state published next time.
  const settle = (value: boolean, current: number) => {
    completed = current;
    actual = value;
    options.onLoginItem(value);
    if (current === revision) options.publish(value);
  };
  const loginItem = createLoginItemSync(
    { dev: options.dev, env: options.originalEnv },
    (openAtLogin) => {
      const current = ++revision;
      const operation = tail.then(async () => {
        try {
          const before = await getLoginItem(loginOptions);
          if (before !== openAtLogin) await setLoginItem({ ...loginOptions, openAtLogin });
          const settled = await getLoginItem(loginOptions);
          settle(settled, current);
          if (settled !== openAtLogin) throw new Error("Login item unchanged");
        } catch {
          options.logger.warn("login item setup unavailable");
          try {
            const settled = await getLoginItem(loginOptions);
            settle(settled, current);
          } catch {
            options.logger.warn("login item state unavailable");
          }
          // The OS error can quote a path; the caller only needs to know the write failed.
          throw new Error("Login item unavailable");
        }
      });
      // Preserve the queue after a rejected operation; the caller still receives its rejection.
      tail = operation.catch(() => {});
      return operation;
    },
  );
  return {
    loginItem,
    /** Tell a freshly ready child the actual value, unless a newer request is still in flight. */
    apply() {
      if (actual !== undefined && completed === revision) sync(actual);
    },
    /** Let the stop path wait for the last queued write. */
    settled: () => tail,
  };
}
