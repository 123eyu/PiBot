import { z } from "zod";

const id = z.uuid();
const count = z.number().int().nonnegative().safe();
// These are identifiers, never an exception message, tool output or a user-supplied label.
export const DiagnosticCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,79}$/);
const code = DiagnosticCodeSchema.nullable();
export const DiagnosticPermissionSchema = z.strictObject({
  state: z.enum(["unknown", "not_needed", "granted", "denied", "observed"]),
  nativeStatus: z.number().int().min(0).max(4).nullable(),
  observedAt: z.iso.datetime().nullable(),
});
export const DiagnosticRunSchema = z.strictObject({
  runId: id,
  status: z.enum([
    "queued",
    "running",
    "waiting",
    "stopping",
    "done",
    "error",
    "aborted",
    "cancelled",
    "interrupted",
    "timeout",
    "failed",
  ]),
  stopReason: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/)
    .nullable(),
  errorCode: code,
  toolCallCount: count,
  zeroToolCalls: z.boolean(),
  unfinishedTodoCount: count.nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export const DiagnosticToolSchema = z.strictObject({
  runId: id.nullable(),
  tool: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.:-]{0,255}$/),
  status: z.enum(["pending", "running", "done", "error", "blocked", "aborted"]),
  errorCode: code,
  durationMs: count.nullable(),
  resultCount: count.nullable(),
  connectorId: id.nullable(),
  createdAt: z.iso.datetime(),
});
export const DiagnosticsSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  capturedAt: z.iso.datetime(),
  connections: z
    .array(
      z.strictObject({
        id,
        type: z.enum(["mcp_remote", "mcp_stdio", "builtin", "rest"]),
        status: z.enum([
          "disabled",
          "starting",
          "ready",
          "idle",
          "needs_setup",
          "needs_auth",
          "error",
          "stopping",
        ]),
        errorCode: code,
        errorAt: z.iso.datetime().nullable(),
      }),
    )
    .max(500),
  connectionsTruncated: z.boolean(),
  permissions: z.strictObject({
    accessibility: DiagnosticPermissionSchema,
    screenRecording: DiagnosticPermissionSchema,
    contacts: DiagnosticPermissionSchema,
    calendar: DiagnosticPermissionSchema,
  }),
  runs: z.array(DiagnosticRunSchema).max(50),
  tools: z.array(DiagnosticToolSchema).max(200),
});
export type DiagnosticsSnapshot = z.infer<typeof DiagnosticsSnapshotSchema>;
export type DiagnosticRun = z.infer<typeof DiagnosticRunSchema>;
export const DiagnosticsMethods = {
  "diagnostics.snapshot": {
    params: z.union([z.undefined(), z.strictObject({})]),
    result: DiagnosticsSnapshotSchema,
  },
} as const;

export function diagnosticCode(value: unknown): string | null {
  const result = DiagnosticCodeSchema.safeParse(value);
  return result.success ? result.data : null;
}

/** Content-free model-cache receipt used by the local cache statistics tool. */
export const CacheRequestReceiptSchema = z.object({
  module: z.literal("agent-cache"),
  event: z.literal("cache_request"),
  api: z.string().regex(/^[a-z0-9-]{1,64}$/),
  intervalMs: z.number().finite().nonnegative().optional(),
  input: z.number().finite().nonnegative().optional(),
  cacheRead: z.number().finite().nonnegative().optional(),
  cacheWrite: z.number().finite().nonnegative().optional(),
});
