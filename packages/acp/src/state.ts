/*
 * The two shapes the ACP connection keeps in memory: one session's state, and the options the host
 * hands `createAcpAgent`.
 */
import type { AcpDebugEvent } from "./approval-requests.ts";
import type { AcpExecutionTarget } from "./execution-target.ts";
import type { AcpSessionMemory } from "./session-memory.ts";
import type { AcpGroupRunReceipt, AcpRuntimePort, AcpTarget } from "./types.ts";

export interface SessionState {
  id: string;
  botId: string;
  /** Absent only for legacy Bot sessions. Group identity is never inferred from botId. */
  target?: AcpTarget;
  groupRun?: AcpGroupRunReceipt;
  attached?: boolean;
  roots: string[];
  topics: Map<string, string>;
  yolo: boolean;
  autoCheck: boolean;
  activeRun?: string;
  activeAbort?: AbortController;
  busy?: boolean;
}

export interface AcpAgentOptions {
  runtime: AcpRuntimePort;
  execution?: AcpExecutionTarget;
  version: string;
  runTimeoutMs?: number;
  /** Bound on one session/prompt turn (default 3 hours). */
  promptTimeoutMs?: number;
  maxSessions?: number;
  permissionBudget?: { requests: number; bytes: number };
  onPermissionCapacity?(): void;
  outputBudget?: { events: number; bytes: number };
  debug?(event: AcpDebugEvent): void;
  /** Shared across connections by the host; enables session/load of ACP-created sessions. */
  sessionMemory?: AcpSessionMemory;
}
