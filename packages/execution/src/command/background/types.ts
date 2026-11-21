import type { ExecRedactor } from "../../core/types.ts";
import type { ListenerScan } from "../../listeners/index.ts";
import type { createTreeState, ProcessRow } from "../process-tree.ts";

export interface BackgroundDependencies {
  platform: NodeJS.Platform;
  /** Clean tool environment (PATH / SHELL) for ps, lsof and PowerShell. */
  env: () => NodeJS.ProcessEnv;
  redactor: ExecRedactor;
  onMonitorFailure?(id: string): void;
  /**
   * A cleanup that cannot be confirmed pauses new commands; each state is reported so the caller
   * can log it and explain it (an unexplained pause looked like a policy failure).
   */
  onDrain?(event: BackgroundDrainEvent): void;
}

export type BackgroundEndReason = "exited" | "stopped" | "exposed" | "failed";

export interface BackgroundProcessRecord {
  /** POSIX process group (= root pid); Windows has none and uses the recorded tree only. */
  group: number;
  processes: { pid: number; started: string }[];
}

/** Fixed reason codes, so a log line never carries command text, paths or raw OS errors. */
export type BackgroundDrainReason = "cleanup_unconfirmed" | "cleanup_unverified" | "unknown";

export interface BackgroundDrainEvent {
  phase: "paused" | "retrying" | "recovered";
  reason: BackgroundDrainReason;
  /** The job whose cleanup was not confirmed, when one job caused it. */
  jobId?: string;
  /** Cleanup attempts so far; zero for the first failure. */
  attempts: number;
  /** Processes or groups still found after the last attempt; zero once it is confirmed clean. */
  remaining: number;
}

export interface BackgroundJob {
  readonly id: string;
  readonly logPath: string;
  readonly running: boolean;
  /** Absent on targets that do not provide cumulative output progress. */
  readonly outputLines?: number;
  /** Set only after confirmed exit 1 with complete, exclusively recognized permission stderr. */
  readonly permissionOnly?: boolean;
  /** Latest listener scan of the whole tree; `supported: false` for a Linux sandbox (see ListenerScan). */
  readonly listeners: ListenerScan;
  /** Loopback TCP ports the tree listens on now, newest discovered first and unique. */
  ports(): number[];
  /** Redacted recent output, at most `maxChars`; presentation notices are separate facts. */
  output(maxChars: number): string;
  record(): BackgroundProcessRecord;
  writeInput(
    text: string,
    eof: boolean,
    signal: AbortSignal,
    assertAuthorized: () => void | Promise<void>,
  ): Promise<{ bytes: number; eof: boolean }>;
  stop(): Promise<void>;
  readonly ended: Promise<{
    exitCode: number | null;
    reason: BackgroundEndReason;
    errorCode?: "listener_check_failed";
  }>;
}

export interface BackgroundCallbacks {
  /** Bounded numeric progress only; never persists the process registry or output. */
  onProgress?(job: BackgroundJob): void;
  /** Membership or listening ports changed (persist the record, refresh browser rules). */
  onChange?(job: BackgroundJob): void;
}

export interface Spec {
  id: string;
  toolCallId?: string;
  shell: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  callbacks: BackgroundCallbacks;
  /**
   * The process is a sandbox host (sandbox-host.ts) that runs the command under its own SRT
   * instance: it receives `payload` on stdin, reports readiness on fd 3, and its own proxy
   * listeners are not the Bot's ports.
   */
  beforeSpawn?(): void | Promise<void>;
  host?: {
    payload: string;
    signal: AbortSignal;
    prepared?(): Promise<void>;
    dispatch?(): void | Promise<void>;
    cleanup(): Promise<void>;
  };
}

export type Job = BackgroundJob & {
  /** Root pid; on POSIX also the process group the whole command runs in. */
  root: number;
  hosted: boolean;
  callbacks: BackgroundCallbacks;
  tree: ReturnType<typeof createTreeState>;
  members: ProcessRow[];
  startedAt: number;
  rootExited: boolean;
  update(members: ProcessRow[]): boolean;
  setListeners(scan: ListenerScan): boolean;
  finish(reason: BackgroundEndReason): Promise<void>;
  stopFor(reason: BackgroundEndReason): Promise<void>;
  listenerFailure(): void;
  /** Linux: relays the sandbox's loopback listeners to this host (created on first need). */
  forwarder?: import("../../listeners/linux-forward.ts").NamespaceForwarder;
};
