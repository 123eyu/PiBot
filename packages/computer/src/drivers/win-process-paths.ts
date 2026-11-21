import { execFile } from "node:child_process";
import { win32 } from "node:path";
import type { AppInfo as CuaAppInfo } from "@trycua/cua-driver";

/*
 * Cua lists a running packaged (MSIX / Store) app — Notepad, Calculator, Terminal, Photos — and
 * some system programs by exe name and pid only: it cannot read their image path, so they never
 * matched the AUMID their installed row (and the user's grant) carries. Pi Bot asks Windows for
 * the image path of exactly those pids; `windowsAppId` then maps a path inside the system package
 * store to its AUMID, and any other path to its exe name as for ordinary desktop apps. A process
 * Windows will not describe (elevated, already gone) keeps its bare row: unsupported, not guessed.
 */

const QUERY_TIMEOUT_MS = 3000;
// A pid can be reused, so a resolved path is trusted only briefly and only for the same exe name.
const CACHE_MS = 10_000;
const MAX_PIDS = 64;

/**
 * One PowerShell call for all pids. Paths are emitted as Base64 of their UTF-8 bytes: on a
 * Chinese (code page 936) system a redirected PowerShell writes in the OEM code page, and a
 * `C:\Users\张三\…` path would otherwise arrive garbled and never match.
 */
function script(pids: readonly number[]) {
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    `foreach ($p in Get-Process -Id ${pids.join(",")}) {`,
    "  if ($p.Path) { [string]$p.Id + ' ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p.Path)) }",
    "}",
  ].join("\n");
}

function parse(stdout: string, wanted: ReadonlySet<number>) {
  const paths = new Map<number, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(\d{1,10}) ([A-Za-z0-9+/=]{4,8192})$/.exec(line.trim());
    if (!match) continue;
    const pid = Number(match[1]);
    const path = Buffer.from(match[2] as string, "base64").toString("utf8");
    // Only an absolute drive path for a pid we asked about; anything else is ignored.
    if (wanted.has(pid) && /^[A-Za-z]:\\/.test(path) && !/[\p{Cc}]/u.test(path))
      paths.set(pid, win32.normalize(path));
  }
  return paths;
}

export type ProcessPathQuery = (pids: readonly number[], signal?: AbortSignal) => Promise<string>;

const powershellQuery: ProcessPathQuery = (pids, signal) =>
  new Promise((resolve) => {
    const encoded = Buffer.from(script(pids), "utf16le").toString("base64");
    execFile(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { timeout: QUERY_TIMEOUT_MS, windowsHide: true, signal, maxBuffer: 1024 * 1024 },
      // A failed or cancelled query only means those apps stay unresolved, never a wrong id.
      (_error, stdout) => resolve(typeof stdout === "string" ? stdout : ""),
    );
  });

/** Fills `launchPath` of running rows Cua could not describe; other rows pass through as is. */
export function createWindowsProcessPaths(query: ProcessPathQuery = powershellQuery) {
  // `path: undefined` remembers that Windows would not describe the process (elevated): asking
  // again on every list would start PowerShell each time for the same answer.
  const cache = new Map<number, { name: string; path: string | undefined; at: number }>();
  return async function enrich(
    apps: readonly CuaAppInfo[],
    signal?: AbortSignal,
  ): Promise<CuaAppInfo[]> {
    const now = Date.now();
    for (const [pid, entry] of cache) if (now - entry.at > CACHE_MS) cache.delete(pid);
    const missing = apps.filter((app) => app.running && app.pid > 0 && !app.launchPath);
    const unknown = missing
      .filter((app) => cache.get(app.pid)?.name !== app.name)
      .map((app) => app.pid)
      .slice(0, MAX_PIDS);
    if (unknown.length) {
      const resolved = parse(await query(unknown, signal), new Set(unknown));
      const asked = new Set(unknown);
      for (const app of missing)
        if (asked.has(app.pid))
          cache.set(app.pid, { name: app.name, path: resolved.get(app.pid), at: now });
    }
    if (!missing.length) return [...apps];
    return apps.map((app) => {
      if (!app.running || app.pid <= 0 || app.launchPath) return app;
      const cached = cache.get(app.pid);
      return cached?.path && cached.name === app.name ? { ...app, launchPath: cached.path } : app;
    });
  };
}
