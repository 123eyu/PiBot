import type { IsolationStatus } from "@pibot/execution";
// The subpath keeps `pibot status` from loading the whole execution package at startup.
import { linuxRunnerIsolationRemedy } from "@pibot/execution/isolation-remedy";

const MAX_REASON = 100;

/**
 * The runner's log and `pibot runner status` are the only evidence on a headless Linux
 * box, so one record must carry the cause and the fix. Fields stay flat scalars because the logger
 * only accepts them; both languages are kept because the operator and the log reader may differ.
 */
export function isolationFields(isolation: IsolationStatus): Record<string, string | boolean> {
  const remedy = linuxRunnerIsolationRemedy(isolation.reason);
  return {
    available: isolation.available,
    ...(isolation.reason ? { reason: isolation.reason } : {}),
    ...(remedy ? { remedyZh: remedy.zh, remedyEn: remedy.en } : {}),
  };
}

/** The control socket is local and token-guarded, but a stale peer may still answer anything. */
export function parseIsolation(value: unknown): IsolationStatus | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.available !== "boolean") return undefined;
  const reason = candidate.reason;
  if (reason === undefined) return { available: candidate.available };
  if (typeof reason !== "string" || reason.length === 0 || reason.length > MAX_REASON)
    return undefined;
  return { available: candidate.available, reason };
}
