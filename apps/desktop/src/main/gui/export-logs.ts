import { writeFile } from "node:fs/promises";
import { arch, release } from "node:os";
import { app, type BrowserWindow, dialog } from "electron";
import { collectLogBundle } from "./log-bundle.ts";

export { collectLogs } from "./log-bundle.ts";
export type ExportLogsResult = "saved" | "canceled" | "failed";

export async function exportLogs(
  window: BrowserWindow,
  logsDir: string,
  additionalDirs: readonly { name: string; path: string }[] = [],
  snapshot: (signal: AbortSignal) => Promise<unknown> = async () => {
    throw new Error("brain_unavailable");
  },
): Promise<ExportLogsResult> {
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const choice = await dialog.showSaveDialog(window, {
    defaultPath: `pibot-logs-${day}.zip`,
    filters: [{ name: "Zip", extensions: ["zip"] }],
  });
  if (choice.canceled || !choice.filePath) return "canceled";
  const abort = new AbortController();
  const stop = () => abort.abort();
  window.once("closed", stop);
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]);
  try {
    const data = await collectLogBundle({
      logsDir,
      additionalDirs,
      snapshot,
      signal,
      environment: {
        app: {
          version: app.getVersion(),
          commit: typeof __PIBOT_COMMIT__ === "undefined" ? null : __PIBOT_COMMIT__,
        },
        system: {
          platform: process.platform,
          version: release(),
          architecture: arch(),
          language: app.getLocale(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          // Positive east of UTC, so a CST observation carries +480 alongside UTC log timestamps.
          utcOffsetMinutes: -new Date().getTimezoneOffset(),
        },
      },
    });
    signal.throwIfAborted();
    await writeFile(choice.filePath, data, { signal });
    return "saved";
  } catch {
    return "failed";
  } finally {
    window.off("closed", stop);
  }
}
