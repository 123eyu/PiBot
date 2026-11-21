import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type AgentError, mapAgentError, transientRequestError } from "../core/errors.ts";
import type {
  AgentErrorCode,
  AgentRequestObserver,
  SessionEvent,
  ToolSetSnapshot,
} from "../core/types.ts";

const amount = z.number().finite().nonnegative();
const usageSchema = z.object({
  input: amount,
  output: amount,
  cacheRead: amount,
  cacheWrite: amount,
  totalTokens: amount.optional(),
  // `reported`: the provider billed this total itself (patched pi-ai, OpenRouter's usage.cost).
  cost: z.object({ total: amount, reported: z.boolean().optional() }).optional(),
});
/** result() is the SDK's shared final promise; observing it does not consume streaming events. */
export class RequestAccounting {
  readonly managesRetries = true;
  /**
   * Network/429 retries share one allowance across the run's tool/fix turns; a response that
   * arrives resets it, so it bounds a provider that stays down, not a long run.
   */
  retryAttempts = 0;
  /** The last response ended early because its stream dropped after visible text. */
  interrupted = false;
  /** Preserve classification across the SDK's string-only diagnostic boundary. */
  responseError?: AgentError;
  onReconnect?: (event: Extract<SessionEvent, { type: "reconnect" }>) => void;
  private readonly pending = new Set<Promise<void>>();
  private failure?: unknown;
  blocked?: AgentErrorCode;
  constructor(private readonly observer?: AgentRequestObserver) {}
  begin(
    model: {
      provider: string;
      id: string;
      cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    },
    kind: "response" | "compaction" | "auxiliary",
    toolSet?: ToolSetSnapshot,
  ) {
    if (this.failure) throw this.failure;
    const id = randomUUID();
    // An all-zero catalogue entry can be an unpriced subscription. Do not assert free usage.
    const pricingKnown = Object.values(model.cost).some(
      (value) => Number.isFinite(value) && value > 0,
    );
    try {
      this.observer?.beforeRequest({
        id,
        kind,
        provider: model.provider,
        model: model.id,
        pricingKnown,
        ...(toolSet ? { toolSet } : {}),
      });
    } catch (error) {
      this.blocked = mapAgentError(error);
      throw error;
    }
    let settled = false;
    return {
      settle: (
        result?: { stopReason: string; usage?: unknown },
        failure?: { error: unknown; outputObserved: boolean },
      ) => {
        if (settled) return false;
        settled = true;
        const complete =
          !!result && result.stopReason !== "error" && result.stopReason !== "aborted";
        const parsed = usageSchema.safeParse(result?.usage);
        const usage = parsed?.success ? parsed.data : undefined;
        const tokens = usage
          ? (usage.totalTokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite)
          : undefined;
        // Aborted/error SDK messages can carry billed partial usage, or merely default zeroes.
        const knownTokens = tokens !== undefined && (complete || tokens > 0);
        const reportedCost =
          pricingKnown || usage?.cost?.reported === true ? usage?.cost?.total : undefined;
        const partialCost =
          !complete && knownTokens && usage && pricingKnown
            ? (usage.input * model.cost.input +
                usage.output * model.cost.output +
                usage.cacheRead * model.cost.cacheRead +
                usage.cacheWrite * model.cost.cacheWrite) /
              1_000_000
            : undefined;
        // Count only tokens the provider actually reported, never estimate unobserved streaming text.
        const cost =
          reportedCost && reportedCost > 0 ? reportedCost : (partialCost ?? reportedCost);
        const knownCost = cost !== undefined && (complete || cost > 0);
        // Missing usage alone proves nothing. Only the stream owner can attest no output;
        // positive partial usage always wins, including tokens on an unpriced provider.
        const unbilled =
          result?.stopReason === "error" &&
          !!failure &&
          !failure.outputObserved &&
          (result.usage === undefined ||
            (usage !== undefined &&
              [
                usage.input,
                usage.output,
                usage.cacheRead,
                usage.cacheWrite,
                usage.totalTokens ?? 0,
                usage.cost?.total ?? 0,
              ].every((value) => value === 0))) &&
          !!transientRequestError(failure.error);
        this.observer?.settled({
          id,
          complete,
          ...(unbilled
            ? { usage: { tokens: 0, costUsd: 0 } }
            : knownTokens || knownCost
              ? {
                  usage: {
                    ...(knownTokens ? { tokens } : {}),
                    ...(knownCost ? { costUsd: cost } : {}),
                  },
                }
              : {}),
        });
        return unbilled;
      },
    };
  }
  track(pending: Promise<void>) {
    const observed = pending.catch((error) => {
      this.failure = error;
    });
    this.pending.add(observed);
    void observed.finally(() => this.pending.delete(observed));
  }
  observe<T extends { stopReason: string; usage?: unknown }>(
    receipt: ReturnType<RequestAccounting["begin"]>,
    result: Promise<T>,
  ) {
    const pending = result
      .then(
        (value) => {
          receipt.settle(value);
        },
        () => {
          receipt.settle();
        },
      )
      .catch((error) => {
        this.failure = error;
      });
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending));
  }
  async drain() {
    while (this.pending.size) await Promise.all([...this.pending]);
    if (this.failure) throw this.failure;
  }
}
