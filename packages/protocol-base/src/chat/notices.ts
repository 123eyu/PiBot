import { z } from "zod";
import { ComputerAppSchema } from "../computer/apps.ts";
import { ComputerFailureCodeSchema } from "../computer/host.ts";
import {
  ConnectionAvailabilitySchema,
  ConnectionTargetSchema,
} from "../connectors/availability.ts";
import { IdSchema } from "../core/ids.ts";
import { PageSchema } from "../core/page.ts";
import { SandboxBlockKindSchema } from "../execution/sandbox-block.ts";
import { DomainSchema } from "../permissions/settings.ts";

// Same shape as AutoCheckCommandSchema (auto-check.ts imports this file, so it is not reused).
const checkCommand = z.string().min(1).max(1000);

/**
 * A system record shown as a centered line in a chat (DM topic or group), e.g. "you took over the
 * browser for 2 minutes · handed back to Researcher". Records are facts for the user only: they
 * live outside `messages`, so no model context, read_messages, search or unread count sees them.
 * New kinds are appended to the union.
 */
/**
 * Which fixed sentence a "come help for a moment" card shows. Brain picks it from the host
 * failure; the renderer words it per platform (`platform`) and language, never the model.
 */
export const ComputerHandoffMessageSchema = z.enum([
  "accessibility",
  "screen_recording",
  "screen_recording_not_effective",
  "open_window",
  "window_minimized",
  "window_other_space",
  "window_covered",
  "window_other",
  "retry_limit",
]);
export const ComputerHandoffStatusSchema = z.enum([
  "pending",
  "continued",
  "declined",
  "timeout",
  "cancelled",
]);
/** The Bot cannot get past a computer step on its own and waits for the user. */
export const ComputerHandoffNoticeSchema = z.strictObject({
  id: IdSchema,
  conversationId: IdSchema,
  botId: IdSchema,
  kind: z.literal("computer_handoff"),
  runId: IdSchema,
  /** The computer tool of the step ("screenshot", "ui_tree", …), for "{step}" in the sentence. */
  tool: z
    .string()
    .max(40)
    .regex(/^[a-z_]+$/),
  app: ComputerAppSchema,
  code: ComputerFailureCodeSchema,
  /** The host's machine hint (never screen text); kept for the record, not shown as is. */
  detail: z.string().max(500).optional(),
  message: ComputerHandoffMessageSchema,
  platform: z.enum(["darwin", "win32", "linux"]),
  status: ComputerHandoffStatusSchema,
  /** When an unanswered card counts as "not handled" (10 min in chat, the routine's wait). */
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().optional(),
});

export const ChatNoticeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    id: IdSchema,
    conversationId: IdSchema,
    botId: IdSchema,
    kind: z.literal("connection_needed"),
    runId: IdSchema,
    target: ConnectionTargetSchema,
    availability: ConnectionAvailabilitySchema,
    createdAt: z.iso.datetime(),
  }),
  z.strictObject({
    id: IdSchema,
    conversationId: IdSchema,
    /** The Bot whose browser was taken over and handed back. */
    botId: IdSchema,
    kind: z.literal("browser_handback"),
    durationMs: z.number().int().nonnegative().safe(),
    /** Sites (hostnames only, never what was typed) the user was on during the takeover. */
    domains: z.array(DomainSchema).max(3),
    /**
     * Sites where a login form was submitted during the takeover (hostnames only). The
     * line then says "signed in to" these instead of "visited". Absent on older records.
     */
    signedIn: z.array(DomainSchema).min(1).max(3).optional(),
    createdAt: z.iso.datetime(),
  }),
  /**
   * One automatic check after a turn that changed code (updated in place while it runs).
   * `round` 0 is the check right after the turn; 1..maxRounds follow a fix the Bot was asked for.
   */
  z.strictObject({
    id: IdSchema,
    conversationId: IdSchema,
    botId: IdSchema,
    kind: z.literal("auto_check"),
    runId: IdSchema,
    status: z.enum(["running", "passed", "failed", "timeout", "blocked", "stopped"]),
    failureKind: z.literal("environment").optional(),
    commands: z.array(checkCommand).min(1).max(3),
    /** Same-run completed tool receipts, not freshly executed automatic commands. */
    reusedChecks: z
      .array(
        z.strictObject({
          index: z.number().int().min(0).max(2),
          toolCallId: z.string().min(1).max(300),
        }),
      )
      .max(3)
      .optional(),
    /** Index in `commands` of the command that failed (or was blocked / stopped). */
    failedIndex: z.number().int().min(0).max(2).optional(),
    round: z.number().int().min(0).max(3),
    maxRounds: z.number().int().min(0).max(3),
    durationMs: z.number().int().nonnegative().safe().optional(),
    exitCode: z.number().int().safe().nullable().optional(),
    /** Last lines of the failing command's output, already redacted. */
    tail: z.string().max(8000).optional(),
    /** The output was sent back to the Bot for another fix round. */
    followUp: z.boolean().optional(),
    /** Failed with no rounds left: the user is told to take over. */
    limitReached: z.boolean().optional(),
    createdAt: z.iso.datetime(),
  }),
  /** The Bot's proposed check command(s) for this folder, waiting for the user. */
  z.strictObject({
    id: IdSchema,
    conversationId: IdSchema,
    botId: IdSchema,
    kind: z.literal("auto_check_proposal"),
    runId: IdSchema,
    status: z.enum(["pending", "accepted", "declined"]),
    commands: z.array(checkCommand).min(1).max(3),
    /** Folder name only (its path is resolved by brain when the card is answered). */
    folderName: z.string().max(400),
    /** Why the Bot picked these (e.g. "package.json has a test script"); untrusted model text. */
    note: z.string().max(500).optional(),
    createdAt: z.iso.datetime(),
  }),
  ComputerHandoffNoticeSchema,
  z.strictObject({
    id: IdSchema,
    conversationId: IdSchema,
    botId: IdSchema,
    kind: z.literal("attachment_delivery_missing"),
    runId: IdSchema,
    createdAt: z.iso.datetime(),
  }),
  z.strictObject({
    id: IdSchema,
    conversationId: IdSchema,
    botId: IdSchema,
    kind: z.literal("browser_extension"),
    createdAt: z.iso.datetime(),
  }),
  /**
   * A Bot proposed moving this DM topic's working folder to a folder on a paired runner.
   * Nothing changes until the user accepts on the card (never YOLO, a grant or a routine).
   */
  z.strictObject({
    id: IdSchema,
    conversationId: IdSchema,
    botId: IdSchema,
    kind: z.literal("workplace_move_proposal"),
    runId: IdSchema,
    status: z.enum(["pending", "accepted", "declined"]),
    location: z.string().regex(/^runner:[a-f0-9]{64}$/),
    /** The runner's name when proposed (the device may be renamed later). */
    runnerName: z.string().max(200),
    path: z.string().min(1).max(32768),
    /** Why the Bot proposes it; untrusted model text. */
    note: z.string().max(500).optional(),
    createdAt: z.iso.datetime(),
  }),
  /**
   * Automatic follow-ups of a topic stopped for good. Facts only: why, and how many rounds
   * the chain had spent; the plan and the results stay in their own records.
   */
  z.strictObject({
    id: IdSchema,
    conversationId: IdSchema,
    botId: IdSchema,
    kind: z.literal("continuation_stopped"),
    /** The root run whose chain stopped. */
    runId: IdSchema,
    reasonCode: z.enum(["round_limit", "no_progress", "authority_narrowed", "restart_dropped"]),
    used: z.number().int().nonnegative().safe(),
    createdAt: z.iso.datetime(),
  }),
  /**
   * A warning an external agent printed about its own startup (Codex's "Under-development
   * features enabled …" from the user's config) instead of a step inside the reply. Kept once per
   * conversation per text, since the agent repeats it every turn.
   */
  z.strictObject({
    id: IdSchema,
    conversationId: IdSchema,
    botId: IdSchema,
    kind: z.literal("agent_warning"),
    /** The run whose reply it was taken from. */
    runId: IdSchema,
    /** The agent's display name ("Codex", a custom agent's own name) when known. */
    agent: z.string().min(1).max(60).optional(),
    /** Untrusted agent text: redacted, one line, capped; shown as plain text only. */
    text: z.string().min(1).max(300),
    /** Anchored diagnostic; permission actions must reread the brain's stored candidate. */
    sandbox: z
      .strictObject({
        toolCallId: z.string().min(1).optional(),
        kind: SandboxBlockKindSchema,
        rule: z.string().min(1).max(128),
        target: z.string().min(1).max(256),
        program: z.string().min(1).max(128).optional(),
        approvalId: IdSchema.optional(),
        approvalToolCallId: z.string().min(1).optional(),
        /** Brain-issued public-domain candidate, with the original permission owner. */
        website: z.strictObject({ domain: DomainSchema, groupId: IdSchema.optional() }).optional(),
      })
      .optional(),
    createdAt: z.iso.datetime(),
  }),
]);

export const ChatNoticeMethods = {
  // Newest first, `before` is a notice id (same cursor rules as the other paged lists).
  "chat.notices": {
    params: PageSchema.extend({ conversationId: IdSchema }),
    result: z.array(ChatNoticeSchema).max(200),
  },
};

export const ChatNoticeEvents = {
  "chat.notice": ChatNoticeSchema,
};

export type ChatNotice = z.infer<typeof ChatNoticeSchema>;
export type ComputerHandoffNotice = z.infer<typeof ComputerHandoffNoticeSchema>;
export type ComputerHandoffMessage = z.infer<typeof ComputerHandoffMessageSchema>;
export type ComputerHandoffStatus = z.infer<typeof ComputerHandoffStatusSchema>;
