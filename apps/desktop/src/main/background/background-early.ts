import type { Logger } from "@pibot/observability";
import { readSystemLocale } from "../window/system-locale.ts";
import { reserveDescriptor } from "./background-directory.ts";
import { createWindowsBackgroundSecurity } from "./windows-background-security.ts";

/**
 * Owner steps that need no role module, started next to the owner role import instead of
 * after it. The writer claim and private descriptor (on Windows the ACL checks) and the display
 * language used to wait for ~0.4-1.8 s of role graph evaluation, then for each other. The claim is
 * still taken only with the single-instance lock held, before any brain bootstrap, and the role
 * owns release once it adopts the result; a role that never starts leaves a claim that the next
 * owner reclaims only after proving this PID dead, as after a crash.
 */
export function prepareOwnerEarly(options: {
  dataDir: string;
  version: string;
  originalEnv: Readonly<NodeJS.ProcessEnv>;
  executable: string;
  locale: string;
  logger: Logger;
  signal: AbortSignal;
}) {
  const systemRoot = options.originalEnv.SystemRoot ?? options.originalEnv.SYSTEMROOT;
  const windows =
    process.platform === "win32"
      ? createWindowsBackgroundSecurity({
          systemRoot,
          executable: options.executable,
          logger: options.logger,
        })
      : undefined;
  const reservation = reserveDescriptor(
    options.dataDir,
    options.version,
    true,
    windows,
    options.signal,
  );
  // The role awaits it; an early failure must not surface as an unhandled rejection first.
  void reservation.catch(() => {});
  const systemLocale = readSystemLocale({
    platform: process.platform,
    fallback: options.locale,
    systemRoot,
    logger: options.logger,
    // One warm PowerShell per process (win-startup): the locale read shares the ACL checks' worker.
    powershell: windows?.powershell,
    signal: options.signal,
  });
  return { windows, reservation, systemLocale };
}
export type EarlyOwnerPreparation = ReturnType<typeof prepareOwnerEarly>;
