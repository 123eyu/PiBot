import { IdSchema } from "@pibot/protocol-base";
import { z } from "zod";
import { CustomAgentSchema, ExternalAgentIdSchema } from "../agents/catalog.ts";

/**
 * How this platform runs agents: the outer sandbox, or (Windows) unisolated once the user
 * confirmed that agent ("unconfirmed" until then).
 */
export const AgentIsolationSchema = z.enum(["sandbox", "unisolated", "unconfirmed", "unavailable"]);

const version = z.string().max(100);
const path = z.string().max(4096);

/** One agent as found on this computer. Only names and versions, never account data. */
export const DetectedAgentSchema = z.strictObject({
  agentId: ExternalAgentIdSchema,
  installed: z.boolean(),
  /** The resolved program path (the user's own installation). */
  program: path.nullable(),
  /** `--version` output (first line, capped); null when not run (Windows before confirm). */
  version: version.nullable(),
  adapter: z
    .strictObject({ version, bytes: z.number().int().min(0), installed: z.boolean() })
    .nullable(),
  /** Windows: the user confirmed running this agent without isolation. */
  confirmedUnisolated: z.boolean(),
});
export type DetectedAgent = z.infer<typeof DetectedAgentSchema>;

export const AgentBotSummarySchema = z.strictObject({
  botId: IdSchema,
  name: z.string().max(200),
  agentId: ExternalAgentIdSchema,
  custom: CustomAgentSchema.nullable(),
  adapterVersion: version.nullable(),
  /** Windows: this agent (this exact custom command) is confirmed to run unisolated. */
  confirmedUnisolated: z.boolean(),
  shareUserMemory: z.boolean().optional(),
});
export type AgentBotSummary = z.infer<typeof AgentBotSummarySchema>;

export const AgentAccountStatusSchema = z.strictObject({
  kind: z.enum(["unknown", "login_required", "quota"]),
  checkedAt: z.string().datetime().nullable(),
  command: z.string().max(200).nullable(),
});
export type AgentAccountStatus = z.infer<typeof AgentAccountStatusSchema>;

const option = z.strictObject({ id: z.string().max(600), name: z.string().max(500) });
/** What the agent itself offers for a topic (ACP modes / select config options), last seen. */
export const AgentSessionOptionsSchema = z.strictObject({
  mode: z
    .strictObject({ current: z.string().max(200), options: z.array(option).max(256) })
    .nullable(),
  model: z
    .strictObject({
      configId: z.string().max(200),
      current: z.string().max(600),
      // OpenCode lists every model of every provider (650 on the owner's machine).
      options: z.array(option).max(4096),
    })
    .nullable(),
  /**
   * The agent's other select settings (ACP config options), in its own order and names: reasoning
   * effort (`thought_level`), speed (Codex `fast-mode`, Claude `fast`) and whatever else it offers.
   * Only what the agent offers is shown; older stored rows have none.
   */
  settings: z
    .array(
      z.strictObject({
        configId: z.string().max(200),
        name: z.string().max(200),
        kind: z.enum(["effort", "speed", "other"]),
        current: z.string().max(600),
        options: z.array(option).max(1024),
      }),
    )
    .max(32)
    .default([]),
  /**
   * A model id the user typed that the agent refused when its session opened (it then runs on its
   * own default); shown next to the model picker.
   */
  refusedModel: z.string().max(600).nullable().default(null),
  /**
   * The agent's own slash commands and custom prompts (`available_commands_update`): typed as
   * `/name` at the start of a message, the agent runs them itself.
   */
  commands: z
    .array(
      z.strictObject({
        name: z.string().max(200),
        description: z.string().max(300),
        /** What to type after `/name ` (ACP `input.hint`); empty when it takes none. */
        hint: z.string().max(200).default(""),
      }),
    )
    .max(1000)
    .default([]),
});
export type AgentSessionOptions = z.infer<typeof AgentSessionOptionsSchema>;
export type AgentSetting = AgentSessionOptions["settings"][number];

export const AgentDetectionSchema = z.strictObject({
  isolation: AgentIsolationSchema,
  agents: z.array(DetectedAgentSchema).max(8),
});
export type AgentDetection = z.infer<typeof AgentDetectionSchema>;

export const ExternalAgentMethods = {
  "externalAgents.setMemorySharing": {
    params: z.strictObject({ botId: IdSchema, enabled: z.boolean() }),
    result: z.strictObject({ enabled: z.boolean() }),
  },
  /**
   * The brain detects in the background shortly after start and keeps the result (owner
   * 2026-11-14): this returns it at once and refreshes in the background (`externalAgents.detected`
   * reports a change). `refresh` waits for a fresh result (the "detect again" link). Detection
   * looks at PATH and fixed install folders and reads versions without a process where it can.
   */
  "externalAgents.detect": {
    params: z.strictObject({ refresh: z.literal(true).optional() }),
    result: AgentDetectionSchema,
  },
  "externalAgents.list": {
    params: z.strictObject({}),
    result: z.strictObject({ bots: z.array(AgentBotSummarySchema).max(200) }),
  },
  "externalAgents.checkStatus": {
    params: z.strictObject({ botId: IdSchema, force: z.boolean().optional() }),
    result: AgentAccountStatusSchema,
  },
  "externalAgents.status": {
    params: z.strictObject({ botId: IdSchema }),
    result: AgentAccountStatusSchema,
  },
  "externalAgents.prewarm": {
    params: z.strictObject({ botId: IdSchema, conversationId: IdSchema }),
    result: z.strictObject({ started: z.boolean() }),
  },
  /** User consent is this call (the "download and create" button); pinned version, checked. */
  "externalAgents.installAdapter": {
    params: z.strictObject({ agentId: ExternalAgentIdSchema }),
    result: z.strictObject({ version }),
  },
  "externalAgents.removeAdapter": {
    params: z.strictObject({ agentId: ExternalAgentIdSchema }),
    result: z.strictObject({ removed: z.boolean() }),
  },
  /** Decision 5: Windows runs an agent unisolated only after this per-agent confirm. */
  "externalAgents.confirmUnisolated": {
    params: z.strictObject({
      agentId: ExternalAgentIdSchema,
      /** Required for a custom command: the confirmation covers that Bot's exact command. */
      botId: IdSchema.optional(),
      confirmed: z.literal(true),
    }),
    result: z.strictObject({ confirmed: z.boolean() }),
  },
  "externalAgents.revokeUnisolated": {
    params: z.strictObject({ agentId: ExternalAgentIdSchema, botId: IdSchema.optional() }),
    result: z.strictObject({ revoked: z.boolean() }),
  },
  "externalAgents.createBot": {
    params: z.strictObject({
      agentId: ExternalAgentIdSchema,
      name: z.string().trim().min(1).max(60).optional(),
      custom: CustomAgentSchema.optional(),
    }),
    result: z.strictObject({ botId: IdSchema }),
  },
  "externalAgents.bot": {
    params: z.strictObject({ botId: IdSchema }),
    result: z.strictObject({
      bot: AgentBotSummarySchema,
      isolation: AgentIsolationSchema,
      detected: DetectedAgentSchema.nullable(),
      allowances: z.strictObject({
        readWrite: z.array(path).max(16),
        readOnly: z.array(path).max(8),
        network: z.array(z.string().max(253)).max(32),
        unixSockets: z.array(path).max(4),
      }),
    }),
  },
  /**
   * A topic's options (what the agent offered there, with the user's picks), or without a topic
   * the Bot's: the last options any of its topics saw, with the Bot's defaults.
   */
  "externalAgents.sessionOptions": {
    params: z.strictObject({ botId: IdSchema, conversationId: IdSchema.optional() }),
    result: AgentSessionOptionsSchema.extend({
      /** What Pi Bot tells the user about this agent here (Codex: no per-command asking). */
      notices: z
        .array(z.enum(["no_per_command_ask"]))
        .max(4)
        .default([]),
    }),
  },
  /**
   * In a topic: remembered for it, applied to the live session now when the agent is idle
   * (otherwise when it opens), and kept as the Bot's default for new topics. Without a topic
   * (the Bot profile): the Bot's default only.
   */
  "externalAgents.setOption": {
    params: z
      .strictObject({
        botId: IdSchema,
        conversationId: IdSchema.optional(),
        kind: z.enum(["mode", "model", "config"]),
        /** Required for `config`: which of the agent's settings. */
        configId: z.string().min(1).max(200).optional(),
        value: z.string().min(1).max(600),
      })
      .refine((p) => (p.kind === "config") === !!p.configId, "configId goes with config"),
    result: AgentSessionOptionsSchema,
  },
} as const;

export const ExternalAgentEvents = {
  /** A background detection finished with a result different from the last one. */
  "externalAgents.detected": AgentDetectionSchema,
  /**
   * An agent changed its own options or commands (`available_commands_update` and the like), also
   * between turns: views of that Bot refetch `externalAgents.sessionOptions`.
   */
  "externalAgents.optionsChanged": z.strictObject({
    botId: IdSchema,
    conversationId: IdSchema.optional(),
  }),
  "externalAgents.statusChanged": z.strictObject({
    botId: IdSchema,
    status: AgentAccountStatusSchema,
  }),
} as const;
