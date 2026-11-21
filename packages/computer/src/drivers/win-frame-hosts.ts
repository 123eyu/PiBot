import type { ChildProcessByStdio } from "node:child_process";
import { win32 } from "node:path";
import type { Readable, Writable } from "node:stream";
import { spawnScriptHelper } from "./win-script-helper.ts";

/*
 * Classic store (UWP) apps — Calculator, Settings — draw inside a window owned by
 * ApplicationFrameHost.exe, a process that belongs to no app. Cua lists only that frame host, so
 * Pi Bot answered "unsupported" while agent-desktop did the same task.
 *
 * Windows itself knows the pairing: the app's own window is a child of the frame window and
 * belongs to another process. One PowerShell answers "which process draws in which frame
 * window", plus the image path the AUMID mapping needs (core/windows-app-id.ts, no guessing
 * rule) and the frame's title, which is the app's own name as the OS shows it.
 *
 * It stays resident like win-secure-focus: the first version spawned a fresh PowerShell per call,
 * and
 * Add-Type compiled the Win32 shim each time (2-5 s on a Windows VM), which pushed list_apps from
 * 1.1 s to 5.8 s. Compiling once turns every later query into a window enumeration.
 *
 * A failed or refused query only means those apps stay unresolved — never a wrong identity.
 */

export interface FrameHostWindow {
  /** ApplicationFrameHost.exe process owning the frame window on screen. */
  hostPid: number;
  /** The frame window, as the driver's window id (decimal HWND). */
  windowId: string;
  /** The app process drawing inside it. */
  appPid: number;
  /** That process's image path, when Windows lets us read it. */
  appPath?: string;
  /** The frame window is the foreground window. */
  foreground: boolean;
  /** The frame window's title: the name the app itself shows. */
  title?: string;
}

const QUERY_TIMEOUT_MS = 3000;
/** Add-Type compiles the Win32 shim on the first query; that is startup, not a slow answer. */
const STARTUP_TIMEOUT_MS = 10_000;
// A query is now a window enumeration (milliseconds), so the cache only has to coalesce the
// several lookups one tool call makes (list_apps, then windows / on_screen). Anything longer
// would serve a pairing from before the user opened or closed the app.
const CACHE_MS = 1000;

/** Win32 pairing of frame window → hosted process; one process per frame. */
const SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class PibotFrameHosts {
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder name, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  static string B64(string s) { return Convert.ToBase64String(Encoding.UTF8.GetBytes(s)); }
  public static string[] Frames(int[] hostPids) {
    var hosts = new HashSet<uint>();
    foreach (int p in hostPids) hosts.Add((uint)p);
    IntPtr fg = GetForegroundWindow();
    var found = new List<string>();
    EnumWindows((h, l) => {
      uint owner;
      GetWindowThreadProcessId(h, out owner);
      if (!hosts.Contains(owner)) return true;
      long core = 0;
      long other = 0;
      EnumChildWindows(h, (c, l2) => {
        uint child;
        GetWindowThreadProcessId(c, out child);
        if (child == 0 || hosts.Contains(child)) return true;
        if (other == 0) other = child;
        var cls = new StringBuilder(256);
        GetClassName(c, cls, 256);
        if (cls.ToString() == "Windows.UI.Core.CoreWindow") { core = child; return false; }
        return true;
      }, IntPtr.Zero);
      long app = core != 0 ? core : other;
      if (app == 0) return true;
      var title = new StringBuilder(512);
      GetWindowText(h, title, 512);
      found.Add(owner + " " + h.ToInt64() + " " + app + " " + (h == fg ? "1" : "0") + " " + B64(title.ToString()));
      return true;
    }, IntPtr.Zero);
    return found.ToArray();
  }
}
'@
[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  try {
    $hosts = @(Get-Process ApplicationFrameHost | ForEach-Object { [int]$_.Id })
    if ($hosts.Count -gt 0) {
      foreach ($row in [PibotFrameHosts]::Frames([int[]]$hosts)) {
        $parts = $row -split ' '
        $proc = Get-Process -Id ([int]$parts[2]) -ErrorAction SilentlyContinue
        $path = '-'
        if ($proc -and $proc.Path) { $path = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($proc.Path)) }
        [Console]::Out.WriteLine($row + ' ' + $path)
      }
    }
  } catch {
    # An unanswered query leaves every frame host unresolved; the caller keeps "unsupported".
    [Console]::Out.WriteLine('fail')
  }
  [Console]::Out.WriteLine('end')
  [Console]::Out.Flush()
}
`;

/** One answer: the pairings, or undefined when the helper could not answer. */
export type FrameQuery = (signal?: AbortSignal) => Promise<FrameHostWindow[] | undefined>;

type Helper = ChildProcessByStdio<Writable, Readable, null>;

/**
 * One resident PowerShell, started on the first query. A failed, timed-out or aborted query only
 * means "unknown", never "no store app is running"; the next query starts a fresh helper.
 */
export function createResidentFrames(): { query: FrameQuery; stop(): void } {
  let child: Helper | undefined;
  let buffer = "";
  let ready = false;
  let startAt = 0;
  let readyWaiters: Array<(ok: boolean) => void> = [];
  let pending:
    | {
        resolve: (answer: FrameHostWindow[] | undefined) => void;
        timer: ReturnType<typeof setTimeout>;
        signal?: AbortSignal;
        onAbort?: () => void;
        lines: string[];
        failed: boolean;
      }
    | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const markReady = (ok: boolean) => {
    ready = ok;
    const waiters = readyWaiters;
    readyWaiters = [];
    for (const waiter of waiters) waiter(ok);
  };

  const settle = (answer: FrameHostWindow[] | undefined) => {
    const current = pending;
    if (!current) return;
    pending = undefined;
    clearTimeout(current.timer);
    if (current.signal && current.onAbort)
      current.signal.removeEventListener("abort", current.onAbort);
    current.resolve(answer);
  };

  const finish = (failed: boolean, lines: string[]) => settle(failed ? undefined : parse(lines));

  const stopChild = () => {
    markReady(false);
    const current = child;
    child = undefined;
    buffer = "";
    if (!current) return;
    current.stdin.end();
    current.kill();
  };

  const onLine = (line: string) => {
    const text = line.trim();
    if (!text) return;
    if (text === "ready") return markReady(true);
    const current = pending;
    if (!current) return;
    if (text === "end") return finish(current.failed, current.lines);
    if (text === "fail") current.failed = true;
    else current.lines.push(text);
  };

  const start = (): Helper => {
    ready = false;
    startAt = Date.now();
    const started = spawnScriptHelper(SCRIPT);
    started.stdout.setEncoding("utf8");
    started.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const at = buffer.indexOf("\n");
        if (at < 0) break;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        onLine(line);
      }
    });
    // A dead or unstartable helper only means "unknown"; the next query starts a new one.
    // Only the live helper may say so: an old process finishing after a restart must not mark the
    // new one unready.
    const died = () => {
      if (child !== started) return;
      child = undefined;
      markReady(false);
      settle(undefined);
    };
    started.on("error", died);
    started.on("exit", died);
    child = started;
    return started;
  };

  const waitReady = (started: Helper, signal?: AbortSignal): Promise<boolean> =>
    new Promise((resolve) => {
      if (ready) return resolve(true);
      if (child !== started) return resolve(false);
      const timer = setTimeout(
        () => {
          if (child === started) stopChild();
          resolve(false);
        },
        // Compiling the shim is startup: the first query pays it, later ones are immediate.
        Math.max(STARTUP_TIMEOUT_MS - (Date.now() - startAt), 1000),
      );
      const onAbort = () => {
        clearTimeout(timer);
        resolve(false);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      readyWaiters.push((ok) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(ok);
      });
    });

  const ask = async (signal?: AbortSignal): Promise<FrameHostWindow[] | undefined> => {
    if (signal?.aborted) return undefined;
    let started: Helper;
    try {
      started = child ?? start();
    } catch {
      // Starting PowerShell failed outright; no answer was given, so the frame hosts stay
      // unresolved instead of the caller hearing about a driver error.
      child = undefined;
      return undefined;
    }
    if (!(await waitReady(started, signal))) return undefined;
    if (signal?.aborted) return undefined;
    return new Promise<FrameHostWindow[] | undefined>((resolve) => {
      const timer = setTimeout(() => {
        // A helper that missed its deadline cannot be trusted for the next query either.
        if (child === started) stopChild();
        settle(undefined);
      }, QUERY_TIMEOUT_MS);
      const onAbort = () => {
        if (child === started) stopChild();
        settle(undefined);
      };
      pending = { resolve, timer, signal, onAbort, lines: [], failed: false };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        started.stdin.write("frames\n");
      } catch {
        // The helper died between the check and the write; its exit handler settles the query.
        if (child === started) stopChild();
        settle(undefined);
      }
    });
  };

  return {
    query: (signal) => {
      // One query at a time: the helper answers in order, and two writers would mix lines.
      const next = queue.then(() => ask(signal));
      queue = next.catch(() => undefined);
      return next;
    },
    stop: () => {
      settle(undefined);
      stopChild();
    },
  };
}

// `hostPid hwnd appPid foreground titleB64 pathB64`; paths go base64 for the same reason as in
// win-process-paths.ts (a redirected PowerShell on a code-page-936 system garbles UTF-8 text).
const LINE =
  /^(\d{1,10}) (\d{1,19}) (\d{1,10}) ([01]) ([A-Za-z0-9+/]{0,4096}) ([A-Za-z0-9+/]+={0,2}|-)$/;

function decode(value: string | undefined): string | undefined {
  if (!value || value === "-") return undefined;
  const text = Buffer.from(value, "base64").toString("utf8").trim();
  // A title or path with control characters is not something we can show or compare.
  return !text || /[\p{Cc}]/u.test(text) ? undefined : text;
}

function parse(lines: readonly string[]): FrameHostWindow[] {
  const frames = new Map<string, FrameHostWindow>();
  for (const raw of lines) {
    const match = LINE.exec(raw.trim());
    if (!match) continue;
    const hostPid = Number(match[1]);
    const appPid = Number(match[3]);
    const windowId = match[2];
    if (!Number.isSafeInteger(hostPid) || !Number.isSafeInteger(appPid)) continue;
    if (hostPid <= 0 || appPid <= 0 || !windowId) continue;
    const key = `${hostPid}:${windowId}`;
    if (frames.has(key)) continue;
    frames.set(key, {
      hostPid,
      windowId,
      appPid,
      foreground: match[4] === "1",
      title: decode(match[5]),
      appPath: decode(match[6]),
    });
  }
  return [...frames.values()];
}

/**
 * Cua names the frame host as a plain process; only such a row can stand in for a store app, and
 * when none is on screen the caller can skip the query entirely.
 */
export function isFrameHostApp(app: { name: string; launchPath?: string | null }): boolean {
  const exe = app.launchPath ? win32.basename(app.launchPath) : app.name;
  return /^applicationframehost(\.exe)?$/i.test(exe);
}

/** Frame-host pairings, refreshed at most every second. */
export function createWindowsFrameHosts(probe = createResidentFrames()) {
  let cached: { at: number; list: Promise<FrameHostWindow[]> } | undefined;
  return {
    frames(signal?: AbortSignal): Promise<FrameHostWindow[]> {
      const now = Date.now();
      if (cached && now - cached.at <= CACHE_MS) return cached.list;
      const entry = { at: now, list: Promise.resolve<FrameHostWindow[]>([]) };
      // An unanswered query is served to this caller only: the next one asks again instead of
      // believing a cached "no store app is running" that nobody answered.
      entry.list = probe.query(signal).then((list) => {
        if (!list && cached === entry) cached = undefined;
        return list ?? [];
      });
      cached = entry;
      return entry.list;
    },
    release: () => probe.stop(),
  };
}
