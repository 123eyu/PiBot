// Which operations the macOS sandbox refused for one command, from the kernel's own
// Seatbelt reports. Output alone cannot tell: `aws … 2>&1 | head` exits 0 and prints "Unable to
// locate credentials" because the credential store was unreadable, not because none exists.
//
// Why one monitor per exec, not SRT's per-host monitor (`initialize(…, true)`): SRT would start a
// `log stream` in every sandbox host (one per command) with no readiness signal, so denials of a
// short command could land before the stream attached. One shared stream is started once, gated
// on its header line, and attributes events by the random commandId SRT puts in the deny message
// (`CMD64_<base64 commandId>_END_<session>_SBX`); events of other SRT users are dropped unread.
//
// Authenticity: the commandId is not secret (the command can read it from its proxy username) and
// a sandboxed process may write to the system log (`logger`), so the text alone proves nothing.
// Only structured events whose process is the kernel (processID 0, /kernel) and whose sender is
// the Sandbox extension count; a nested sandbox carrying a forged tag is refused by macOS
// (`sandbox_apply: Operation not permitted`, measured). Each command has its own bounded set, so
// one command's flood cannot push out another's reports.
// The limits come from measurements on macOS.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { childNodeRuntime, unpackedPath } from "../runtime/child-node.ts";

/** A stream that has not printed its header by then is treated as unavailable for this command. */
const READY_MS = 1500;
/** Nothing to watch for this long: stop `log` instead of keeping a process for an idle app. */
const IDLE_MS = 60_000;
/** Seatbelt flushes a sandbox's reports as its last process exits; this covers delivery. */
const SETTLE_MS = 10;
const MAX_LINES = 32;
const MAX_LINE = 600;
/** One ndjson event; kernel deny events are well under 2 KB, anything longer is not one. */
const MAX_EVENT = 16 * 1024;
const RESTART_BACKOFF_MS = 30_000;
const SANDBOX_SENDER = "/System/Library/Extensions/Sandbox.kext/Contents/MacOS/Sandbox";

const KernelEventSchema = z.object({
  processID: z.literal(0),
  processImagePath: z.literal("/kernel"),
  senderImagePath: z.literal(SANDBOX_SENDER),
  eventMessage: z.string().max(MAX_EVENT),
});
/** `Sandbox: ls(1) deny(1) op target` then the profile's tag on the next line, one event. */
const DENY_EVENT = /^Sandbox: ([^\n]+)\nCMD64_([A-Za-z0-9+/=]{1,200})_END_[^\n]*_SBX$/;

/** Next to the bundle in the desktop/runner build, the TypeScript source under plain Node. */
function supervisorScript() {
  const bundled = new URL("./violation-log.js", import.meta.url);
  return existsSync(bundled)
    ? unpackedPath(fileURLToPath(bundled))
    : fileURLToPath(new URL("./violation-log.ts", import.meta.url));
}

export interface ViolationTracker {
  /** Resolves (never rejects) once the stream can see this command's denials, or gave up. */
  ready: Promise<void>;
  /** Stops watching; the deny details (`proc(pid) deny(1) op target`) seen for this command. */
  finish(): Promise<string[]>;
}

export interface ViolationMonitor {
  track(commandId: string): ViolationTracker | undefined;
  dispose(): void;
}

export function createViolationMonitor(
  platform: NodeJS.Platform,
  args?: string[],
): ViolationMonitor {
  if (platform !== "darwin") return { track: () => undefined, dispose() {} };
  const tracked = new Map<string, Set<string>>();
  let child: ChildProcess | undefined;
  let ready: Promise<boolean> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let failedAt = 0;
  let disposed = false;
  let partial = "";

  const stop = () => {
    clearTimeout(idle);
    idle = undefined;
    child?.stdout?.destroy();
    // EOF on the liveness pipe is what the supervisor waits for; the signal is a backstop.
    child?.stdin?.end();
    child?.kill("SIGTERM");
    child = undefined;
    ready = undefined;
    partial = "";
  };

  const event = (text: string) => {
    if (!text.startsWith("{")) return;
    let parsed: z.infer<typeof KernelEventSchema>;
    try {
      const result = KernelEventSchema.safeParse(JSON.parse(text));
      if (!result.success) return;
      parsed = result.data;
    } catch {
      // The header line and anything malformed is not a kernel report.
      return;
    }
    // "1 duplicate report for Sandbox: …" repeats an event already seen.
    const [, detail, encoded] = DENY_EVENT.exec(parsed.eventMessage) ?? [];
    if (!detail?.includes(" deny") || !encoded) return;
    const lines = tracked.get(Buffer.from(encoded, "base64").toString("utf8"));
    if (lines && lines.size < MAX_LINES) lines.add(detail.slice(0, MAX_LINE).trim());
  };

  const start = () => {
    if (child || Date.now() - failedAt < RESTART_BACKOFF_MS) return;
    // Through violation-log.ts, so `log` cannot outlive this process (see that file).
    const spawned = spawn(childNodeRuntime().executable, args ?? [supervisorScript()], {
      env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    child = spawned;
    ready = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), READY_MS);
      timer.unref();
      spawned.stdout?.once("data", () => {
        clearTimeout(timer);
        resolve(true);
      });
      const failed = () => {
        clearTimeout(timer);
        resolve(false);
        if (child === spawned) {
          failedAt = Date.now();
          stop();
        }
      };
      spawned.once("error", failed);
      spawned.once("exit", failed);
    });
    spawned.stdout?.setEncoding("utf8");
    spawned.stdout?.on("data", (chunk: string) => {
      partial += chunk;
      let end = partial.indexOf("\n");
      while (end !== -1) {
        event(partial.slice(0, end));
        partial = partial.slice(end + 1);
        end = partial.indexOf("\n");
      }
      if (partial.length > MAX_EVENT) partial = "";
    });
    // A monitor is a diagnostic aid: neither the process nor its pipe may keep the app alive.
    spawned.unref();
    (spawned.stdout as Socket | null)?.unref?.();
    (spawned.stdin as Socket | null)?.unref?.();
  };

  return {
    track(commandId) {
      if (disposed) return undefined;
      clearTimeout(idle);
      idle = undefined;
      start();
      const current = ready;
      if (!current) return undefined;
      const lines = new Set<string>();
      tracked.set(commandId, lines);
      let finished: Promise<string[]> | undefined;
      const finish = async () => {
        // The host stays alive through the bounded descendant grace and real process-tree
        // cleanup. Only the final kernel delivery interval belongs here, never a new tree owner.
        if (await current) await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
        tracked.delete(commandId);
        if (!tracked.size && !disposed) {
          idle = setTimeout(stop, IDLE_MS);
          idle.unref();
        }
        return [...lines];
      };
      return {
        ready: current.then(() => undefined),
        finish: () => (finished ??= finish()),
      };
    },
    dispose() {
      disposed = true;
      tracked.clear();
      stop();
    },
  };
}
