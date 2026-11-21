import { z } from "zod";

export const ToolPhaseSchema = z.enum(["policy", "approvalWait", "queue", "exec", "post"]);
export type ToolPhase = z.infer<typeof ToolPhaseSchema>;
const milliseconds = z.number().int().nonnegative().safe();
export const ToolPerformanceSchema = z.strictObject({
  durationMs: milliseconds,
  phases: z.strictObject({
    policy: milliseconds,
    approvalWait: milliseconds,
    queue: milliseconds,
    exec: milliseconds,
    post: milliseconds,
  }),
  cache: z.enum(["hit", "miss"]).optional(),
  providerFallback: z.enum(["none", "duckduckgo_unavailable", "duckduckgo_blocked"]).optional(),
});
export type ToolPerformance = z.infer<typeof ToolPerformanceSchema>;

/** An in-memory observer, never an authorization or a model-supplied argument. */
export interface ToolTiming {
  enter(phase: ToolPhase): () => void;
  measure<T>(phase: ToolPhase, action: () => Promise<T>): Promise<T>;
  web(cache: "hit" | "miss", fallback?: ToolPerformance["providerFallback"]): void;
}
