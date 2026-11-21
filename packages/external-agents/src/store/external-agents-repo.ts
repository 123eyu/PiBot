import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type AgentSessionOptions,
  AgentSessionOptionsSchema,
  type CustomAgent,
  CustomAgentSchema,
  type ExternalAgentId,
  ExternalAgentIdSchema,
} from "@pibot/external-agents-contract";
import { z } from "zod";

export interface AgentBotRecord {
  botId: string;
  agentId: ExternalAgentId;
  custom: CustomAgent | null;
  adapterVersion: string | null;
}

export interface AgentSessionRecord {
  sessionId: string;
  cwd: string;
  options: AgentSessionOptions | null;
  preferences: AgentPreferences;
}

const PreferencesSchema = z.strictObject({
  shareUserMemory: z.boolean().optional(),
  mode: z.string().max(200).optional(),
  model: z.string().max(600).optional(),
  /** The agent's other settings by config id (reasoning effort, speed, …). */
  config: z
    .record(z.string().max(200), z.string().max(600))
    .refine((value) => Object.keys(value).length <= 12)
    .optional(),
});

/** Later picks win; `config` merges by setting. */
export function mergePreferences(
  base: AgentPreferences,
  patch: AgentPreferences,
): AgentPreferences {
  const config = { ...(base.config ?? {}), ...(patch.config ?? {}) };
  return PreferencesSchema.parse({
    ...base,
    ...patch,
    ...(Object.keys(config).length ? { config } : {}),
  });
}
export type AgentPreferences = z.infer<typeof PreferencesSchema>;

/** Rows are parsed again on read: a damaged or hand-edited database must not reach a launch. */
function parseJson<T>(value: unknown, schema: z.ZodType<T>): T | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = schema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    // A row that is not JSON is treated like a missing one; the agent re-offers its options.
    return null;
  }
}

/** Which agent a Bot of kind "agent" runs; never an account, token or prompt. */
export class ExternalAgentBotsRepo {
  constructor(private readonly db: DatabaseSync) {}

  create(record: AgentBotRecord) {
    this.db
      .prepare(
        `INSERT INTO external_agent_bots(bot_id, agent_id, custom_json, adapter_version, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        record.botId,
        record.agentId,
        record.custom ? JSON.stringify(CustomAgentSchema.parse(record.custom)) : null,
        record.adapterVersion,
        new Date().toISOString(),
      );
  }

  get(botId: string): AgentBotRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT bot_id, agent_id, custom_json, adapter_version FROM external_agent_bots WHERE bot_id=?",
      )
      .get(botId);
    return row ? this.parse(row) : undefined;
  }

  /** Active agent Bots, newest first; at most 200 (the list the settings page shows). */
  list(): AgentBotRecord[] {
    return this.db
      .prepare(
        `SELECT e.bot_id, e.agent_id, e.custom_json, e.adapter_version FROM external_agent_bots e
         JOIN bots b ON b.id = e.bot_id WHERE b.archived_at IS NULL
         ORDER BY e.created_at DESC LIMIT 200`,
      )
      .all()
      .flatMap((row) => {
        const parsed = this.parse(row);
        return parsed ? [parsed] : [];
      });
  }

  /** The Bot's defaults for new topics and the options its agent last offered anywhere. */
  defaults(botId: string): { options: AgentSessionOptions | null; preferences: AgentPreferences } {
    const row = this.db
      .prepare("SELECT options_json, preferences_json FROM external_agent_bots WHERE bot_id=?")
      .get(botId);
    return {
      options: row ? parseJson(row.options_json, AgentSessionOptionsSchema) : null,
      preferences: (row && parseJson(row.preferences_json, PreferencesSchema)) ?? {},
    };
  }

  saveOptions(botId: string, options: AgentSessionOptions) {
    this.db
      .prepare("UPDATE external_agent_bots SET options_json=? WHERE bot_id=?")
      .run(JSON.stringify(options), botId);
  }

  setDefault(botId: string, patch: AgentPreferences) {
    const preferences = mergePreferences(this.defaults(botId).preferences, patch);
    this.db
      .prepare("UPDATE external_agent_bots SET preferences_json=? WHERE bot_id=?")
      .run(JSON.stringify(preferences), botId);
    return preferences;
  }

  setAdapterVersion(botId: string, version: string | null) {
    this.db
      .prepare("UPDATE external_agent_bots SET adapter_version=? WHERE bot_id=?")
      .run(version, botId);
  }

  private parse(row: Record<string, unknown>): AgentBotRecord | undefined {
    const agentId = ExternalAgentIdSchema.safeParse(row.agent_id);
    if (!agentId.success) return undefined;
    const custom = parseJson(row.custom_json, CustomAgentSchema);
    if (agentId.data === "custom" && !custom) return undefined;
    return {
      botId: String(row.bot_id),
      agentId: agentId.data,
      custom,
      adapterVersion: typeof row.adapter_version === "string" ? row.adapter_version : null,
    };
  }
}

/** The agent's own session id per topic, with what it last offered and what the user picked. */
export class ExternalAgentSessionsRepo {
  constructor(private readonly db: DatabaseSync) {}

  get(botId: string, conversationId: string): AgentSessionRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT session_id, cwd, options_json, preferences_json FROM external_agent_sessions
         WHERE bot_id=? AND conversation_id=?`,
      )
      .get(botId, conversationId);
    if (!row) return undefined;
    return {
      sessionId: String(row.session_id),
      cwd: String(row.cwd),
      options: parseJson(row.options_json, AgentSessionOptionsSchema),
      preferences: parseJson(row.preferences_json, PreferencesSchema) ?? {},
    };
  }

  save(
    botId: string,
    conversationId: string,
    value: { sessionId: string; cwd: string; options: AgentSessionOptions | null },
  ) {
    this.db
      .prepare(
        `INSERT INTO external_agent_sessions(bot_id, conversation_id, session_id, cwd, options_json,
           preferences_json, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(bot_id, conversation_id) DO UPDATE SET session_id=excluded.session_id,
           cwd=excluded.cwd, options_json=excluded.options_json, updated_at=excluded.updated_at`,
      )
      .run(
        botId,
        conversationId,
        value.sessionId,
        value.cwd,
        value.options ? JSON.stringify(value.options) : null,
        new Date().toISOString(),
      );
  }

  saveOptions(botId: string, conversationId: string, options: AgentSessionOptions) {
    this.db
      .prepare(
        `UPDATE external_agent_sessions SET options_json=?, updated_at=?
         WHERE bot_id=? AND conversation_id=?`,
      )
      .run(JSON.stringify(options), new Date().toISOString(), botId, conversationId);
  }

  /** A pick made before the topic has a session is kept on a placeholder row (no session id). */
  setPreference(botId: string, conversationId: string, patch: AgentPreferences) {
    const current = this.get(botId, conversationId);
    const preferences = mergePreferences(current?.preferences ?? {}, patch);
    this.db
      .prepare(
        `INSERT INTO external_agent_sessions(bot_id, conversation_id, session_id, cwd, options_json,
           preferences_json, updated_at) VALUES (?, ?, '', '', NULL, ?, ?)
         ON CONFLICT(bot_id, conversation_id) DO UPDATE SET preferences_json=excluded.preferences_json,
           updated_at=excluded.updated_at`,
      )
      .run(botId, conversationId, JSON.stringify(preferences), new Date().toISOString());
    return preferences;
  }

  forget(botId: string, conversationId: string) {
    this.db
      .prepare(
        "UPDATE external_agent_sessions SET session_id='', cwd='' WHERE bot_id=? AND conversation_id=?",
      )
      .run(botId, conversationId);
  }
}

/**
 * Decision 5: Windows runs an agent unisolated only after this confirmation. The subject
 * names exactly what was confirmed (see `confirmationSubject`), and it can be revoked.
 */
export class ExternalAgentConfirmationsRepo {
  constructor(private readonly db: DatabaseSync) {}

  confirmed(subject: string) {
    return !!this.db
      .prepare("SELECT 1 FROM external_agent_confirmations WHERE subject=?")
      .get(subject);
  }

  confirm(subject: string) {
    this.db
      .prepare(
        `INSERT INTO external_agent_confirmations(subject, confirmed_at) VALUES (?, ?)
         ON CONFLICT(subject) DO NOTHING`,
      )
      .run(subject, new Date().toISOString());
  }

  revoke(subject: string) {
    return (
      this.db.prepare("DELETE FROM external_agent_confirmations WHERE subject=?").run(subject)
        .changes > 0
    );
  }
}

/** A known agent by id; a custom command by its Bot and a digest of program and arguments. */
export function confirmationSubject(
  record: Pick<AgentBotRecord, "agentId" | "custom">,
  botId?: string,
) {
  if (record.agentId !== "custom") return record.agentId;
  if (!botId || !record.custom) throw new Error("custom confirmation needs its Bot");
  const digest = createHash("sha256")
    .update(JSON.stringify([record.custom.command, record.custom.args]))
    .digest("hex");
  return `custom:${botId}:${digest}`;
}
