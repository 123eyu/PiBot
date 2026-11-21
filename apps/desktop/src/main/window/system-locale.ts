import { execFile } from "node:child_process";
import { win32 } from "node:path";
import type { Logger } from "@pibot/observability";
import type { PowerShellWorker } from "../background/powershell-worker.ts";

// .NET only: Get-WinUILanguageOverride / Get-UICulture auto-load the International module, and
// on a fresh or busy Windows the first module load ("Preparing modules for first use") alone
// outlasted the 2 s bound (acceptance VM 2026-11-11), so the language always fell back. The
// process UI culture is the user's effective display language, override included.
const DISPLAY_LANGUAGE_SCRIPT = [
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "[Console]::Write([Globalization.CultureInfo]::CurrentUICulture.Name)",
].join("; ");

/** Display language is independent of Windows' preferred input/content language ordering. */
export async function readSystemLocale(options: {
  platform: NodeJS.Platform;
  fallback: string;
  systemRoot: string | undefined;
  logger: Pick<Logger, "warn">;
  signal?: AbortSignal;
  /**
   * The process's warm PowerShell (windows-background-security), when there is one: a separate
   * cold PowerShell start takes 2–5 s on Windows, longer than this read's bound, so the language
   * always fell back. Sharing the start with the security checks costs nothing extra.
   */
  powershell?: Pick<PowerShellWorker, "run" | "whenReady">;
}): Promise<string> {
  if (options.platform !== "win32") return options.fallback;
  const systemRoot = options.systemRoot;
  if (!systemRoot || !win32.isAbsolute(systemRoot)) {
    options.logger.warn("Windows display language unavailable; using application locale");
    return options.fallback;
  }
  try {
    const result = options.powershell
      ? await viaWorker(options.powershell, options.signal)
      : await spawnOnce(systemRoot, options.signal);
    if (!/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/.test(result) || result.length > 64)
      throw new Error("system_locale_invalid");
    return Intl.getCanonicalLocales(result)[0] ?? options.fallback;
  } catch {
    // Fixed diagnostic only: native errors may include environment-dependent command details.
    options.logger.warn("Windows display language unavailable; using application locale");
    return options.fallback;
  }
}

async function viaWorker(
  worker: Pick<PowerShellWorker, "run" | "whenReady">,
  signal: AbortSignal | undefined,
) {
  // Waits briefly for the shared cold start (it continues for the security checks either way);
  // the read itself keeps the old 2 s bound. A busy machine falls back as before, sooner than a
  // separate PowerShell start would have.
  await worker.whenReady(
    AbortSignal.any([AbortSignal.timeout(3_000), ...(signal ? [signal] : [])]),
  );
  return (
    await worker.run(
      "[Globalization.CultureInfo]::CurrentUICulture.Name",
      AbortSignal.any([AbortSignal.timeout(2_000), ...(signal ? [signal] : [])]),
    )
  ).trim();
}

function spawnOnce(systemRoot: string, signal: AbortSignal | undefined) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(DISPLAY_LANGUAGE_SCRIPT, "utf16le").toString("base64"),
      ],
      {
        timeout: 2_000,
        maxBuffer: 256,
        windowsHide: true,
        encoding: "utf8",
        signal,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    );
  });
}
