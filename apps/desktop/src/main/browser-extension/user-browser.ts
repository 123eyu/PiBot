import { readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createNavigationCheck, type UserBrowser } from "@pibot/browser/host";
import { browserPlatform as botBrowserPlatform } from "../browser-adapter/platform.ts";
import { type BrowserDetection, detectDefaultBrowser } from "./browser-detection.ts";
import { startExtensionServer } from "./extension-server.ts";
import {
  BROWSERS,
  browserProfileRoot,
  registerNativeManifest,
  revokeNativeManifest,
} from "./native-registration.ts";
import { browserExtensionPlatform } from "./platform/index.ts";

const NAMES = {
  chrome: "Google Chrome",
  edge: "Microsoft Edge",
  brave: "Brave",
  chromium: "Chromium",
  firefox: "Firefox",
  safari: "Safari",
  other: "",
} as const;
const DETECT_MS = 60_000;

/**
 * The desktop's half of "Bots work in the user's own browser": the extension endpoint, the
 * default browser, the native messaging manifests and the address policy for navigation checks.
 */
export async function createUserBrowser(options: {
  dataDir: string;
  executable: string;
  /** Development: the app's entry for the launcher; packaged builds start the app itself. */
  entry?: string;
  logger: { info(message: string): void; warn(message: string): void };
  /** Tell brain about a fallback (one grey line in the run's topic). */
  fallback(botId: string, runId: string): void;
  changed(): void;
}): Promise<UserBrowser & { close(): Promise<void> }> {
  const stops = new Set<string>();
  const told = new Set<string>();
  const seenPath = join(options.dataDir, "background-runtime", "browser-extension-seen.json");
  type Seen = Partial<Record<(typeof BROWSERS)[number], number>>;
  // Which browsers' extensions have said hello, and when: the browser to start when none is open.
  const seen: Seen = await readFile(seenPath, "utf8").then(
    (value) => {
      const parsed: unknown = JSON.parse(value);
      const out: Seen = {};
      if (parsed && typeof parsed === "object")
        for (const browser of BROWSERS) {
          const at = (parsed as Record<string, unknown>)[browser];
          if (typeof at === "number" && Number.isFinite(at)) out[browser] = at;
        }
      return out;
    },
    // Missing or unreadable: no browser has connected yet on this data folder.
    () => ({}),
  );
  let server: Awaited<ReturnType<typeof startExtensionServer>> | undefined;
  server = await startExtensionServer({
    dataDir: options.dataDir,
    logger: options.logger,
    onChange: () => {
      const browser = server?.host?.browser as (typeof BROWSERS)[number] | undefined;
      if (browser) {
        seen[browser] = Date.now();
        void writeFile(seenPath, JSON.stringify(seen), { mode: 0o600 }).catch(() =>
          options.logger.warn(
            JSON.stringify({ module: "browser-extension", event: "seen_write_failed" }),
          ),
        );
      }
      options.changed();
    },
    // The toolbar's stop: the Bot's next page action ends with a clear "stopped in your browser".
    onStop: ({ botId }) => stops.add(botId),
  });
  const navigation = createNavigationCheck(botBrowserPlatform().address);
  let detected: { at: number; value: BrowserDetection } | undefined;
  const detect = async () => {
    if (!detected || performance.now() - detected.at > DETECT_MS)
      detected = { at: performance.now(), value: await detectDefaultBrowser(process.platform) };
    return detected.value;
  };
  // Detection runs a system command; keep a fresh answer so routing never waits on it.
  void detect();
  const platform = browserExtensionPlatform();
  // One start attempt at a time, and after a browser that was started never connected (the
  // extension was removed, the browser is broken) page actions go straight to the Bot browser for
  // a while instead of each waiting out the 15 s.
  let starting: Promise<boolean> | undefined;
  let failedAt = 0;
  const ensureConnected = (signal?: AbortSignal): Promise<boolean> => {
    if (server?.host) return Promise.resolve(true);
    if (Date.now() - failedAt < 5 * 60_000) return Promise.resolve(false);
    starting ??= startBrowser(signal)
      .then(
        (ok) => {
          if (!ok) failedAt = Date.now();
          return ok;
        },
        () => {
          failedAt = Date.now();
          return false;
        },
      )
      .finally(() => {
        starting = undefined;
      });
    return starting;
  };
  const startBrowser = async (signal?: AbortSignal) => {
    const value = await detect();
    const candidates = BROWSERS.filter((browser) => seen[browser]);
    const browser =
      value.kind === "supported" && candidates.includes(value.browser)
        ? value.browser
        : candidates.sort((a, b) => (seen[b] ?? 0) - (seen[a] ?? 0))[0];
    if (!browser) return false;
    await platform.launch(browser, signal).catch(() => undefined);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (server?.host) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
      signal?.throwIfAborted();
    }
    return !!server?.host;
  };
  let registered = false;
  return {
    extension: () => {
      const host = server?.host;
      return host
        ? { call: (method, params, signal) => host.call(method as never, params, signal) }
        : undefined;
    },
    browserId: () => {
      const browser = server?.host?.browser;
      return BROWSERS.find((known) => known === browser);
    },
    ensureConnected,
    supported: () => detected?.value.kind === "supported" || Object.keys(seen).length > 0,
    navigation,
    takeStop: (botId: string) => stops.delete(botId),
    fallback: (botId, runId) => {
      // Every page action of a run without the extension lands here; tell the brain once per run.
      if (!runId || told.has(runId)) return;
      told.add(runId);
      if (told.size > 500) told.delete(told.values().next().value as string);
      options.fallback(botId, runId);
    },
    async status() {
      const value = await detect();
      const id = value.kind === "supported" ? value.browser : (value.browser ?? null);
      return {
        defaultBrowser: id ? { id, name: NAMES[id] } : null,
        supported: value.kind === "supported",
        extension: server?.host
          ? "connected"
          : registered && Object.keys(seen).length > 0
            ? "installed"
            : value.kind === "supported"
              ? "not_installed"
              : "unsupported",
      };
    },
    async register(enabled) {
      const home = homedir();
      if (!enabled) {
        for (const browser of BROWSERS)
          if (await revokeNativeManifest({ platform: process.platform, home, browser }))
            options.logger.info(
              JSON.stringify({ module: "browser-extension", event: "revoked", browser }),
            );
        registered = false;
        return;
      }
      const launcher = await platform.createLauncher({
        dataDir: options.dataDir,
        executable: options.executable,
        ...(options.entry ? { entry: options.entry } : {}),
      });
      for (const browser of BROWSERS) {
        // Only browsers this user has (their profile folder exists); Windows reads the registry.
        const root = browserProfileRoot(process.platform, home, browser);
        if (
          root &&
          !(await stat(root).then(
            (info) => info.isDirectory(),
            () => false,
          ))
        )
          continue;
        if (await registerNativeManifest({ platform: process.platform, home, browser, launcher }))
          options.logger.info(
            JSON.stringify({ module: "browser-extension", event: "registered", browser }),
          );
      }
      registered = true;
    },
    close: async () => {
      await server?.close();
    },
  };
}
