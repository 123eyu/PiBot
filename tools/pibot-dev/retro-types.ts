export interface RetroMetric {
  value: number | null;
  coverage: "complete" | "partial" | "unknown";
}
export interface RetroAttribution {
  runIds?: string[];
  sessionIds?: string[];
  groupId?: string;
  cycleIds?: string[];
  /** Derived only from durable ACP receipts, never from the operator's explicit hints. */
  groupScopes?: RetroGroupScope[];
  groupCoverage?: "complete" | "partial" | "unknown";
}
export interface RetroGroupScope {
  groupId: string;
  topicId: string;
  cycleId: string;
  budgetRootRunId: string;
  runId: string;
  assistantMessageId: string;
  runIds: string[];
  runs: { runId: string; botId: string; conversationId: string }[];
}
export type RetroFailure = "policy" | "sandbox" | "tool" | "other";
export interface RetroSummary {
  version: 1;
  taskId: string;
  inputDigest: string;
  generatedAt: string;
  publication: "pending" | "ready" | "failed" | "stale";
  attribution: RetroAttribution;
  logSource: {
    status: "available" | "partial" | "unknown";
    reason:
      | "explicit_logs"
      | "not_configured"
      | "missing_attribution"
      | "missing_logs"
      | "bounded_or_unreadable"
      | "incomplete_window";
  };
  metrics: {
    elapsedMs: RetroMetric;
    actorMs: RetroMetric;
    tools: RetroMetric;
    failedTools: RetroMetric;
    modelRequests: RetroMetric;
    reconnects: RetroMetric;
    toolMs: RetroMetric;
  };
  steps: Record<string, Record<string, number>>;
  failures: Record<RetroFailure, RetroMetric>;
  usage: Record<"requests" | "input" | "output" | "cacheRead" | "cacheWrite", RetroMetric>;
}
export interface RetroEvent {
  runId?: string;
  sessionId?: string;
  taskId?: string;
  botId?: string;
  groupId?: string;
  cycleId?: string;
  topicId?: string;
  conversationId?: string;
  budgetRootRunId?: string;
  event: "model_request" | "model_reconnect" | "tool_result" | "run_end";
  durationMs?: number;
  failed?: boolean;
  failure?: RetroFailure;
}
