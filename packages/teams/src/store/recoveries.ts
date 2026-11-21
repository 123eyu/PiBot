import type { DatabaseSync } from "node:sqlite";
import { IdSchema, LevelSchema, SkillDocumentSchema, ThinkingLevelSchema } from "@pibot/protocol";
import { z } from "zod";

const language = z.enum(["zh", "en"]);
const sourceId = z.string().regex(/^[a-z0-9-]{1,64}$/);
/**
 * One skill exactly as it was on disk before an automatic update replaced it. Files are
 * base64 so a script or a reference image survives the round trip; a restore has to write the
 * same bytes back, not a fingerprint.
 */
const RecoveredFileSchema = z.strictObject({
  path: z.string().max(4096),
  data: z.string().max(8_000_000),
  text: z.boolean(),
  script: z.boolean(),
});
const RecoveredSkillSchema = z.strictObject({
  folder: z.string().max(64),
  enabled: z.boolean(),
  document: SkillDocumentSchema,
  files: z.array(RecoveredFileSchema).max(200),
});
export const BotRecoverySchema = z.strictObject({
  kind: z.literal("bot"),
  language,
  /** The Bot's own working norms, unredacted: the reminder is the only way back to them. */
  norms: z.string().max(20000),
  thinkingLevel: ThinkingLevelSchema,
  /** Only the categories the Bot overrode; the rest followed the global defaults. */
  permissionOverrides: z.record(z.string().max(40), LevelSchema),
  skills: z.array(RecoveredSkillSchema).max(100),
});
export const GroupRecoverySchema = z.strictObject({
  kind: z.literal("group"),
  language,
  announcement: z.string().max(20000),
  autoRoundLimit: z.number().int().min(1).max(10),
});
export type BotRecovery = z.infer<typeof BotRecoverySchema>;
export type GroupRecovery = z.infer<typeof GroupRecoverySchema>;
export interface Recovery<T> {
  sourceId: string;
  fromVersion: number;
  toVersion: number;
  payload: T;
}

/**
 * The Bot's or group's own values from right before the last automatic built-in update.
 * One row per target — the newest overwrite is the one a「恢复上一版」can undo; an older record is
 * reachable again from the built-in version history once it is restored.
 */
export class BuiltinRecoveriesRepo {
  constructor(private readonly db: DatabaseSync) {}
  private read<T>(
    kind: "bot" | "group",
    id: string,
    schema: z.ZodType<T>,
  ): Recovery<T> | undefined {
    const row = this.db
      .prepare(
        "SELECT source_id AS sourceId, from_version AS fromVersion, to_version AS toVersion, payload FROM builtin_recoveries WHERE target_kind=? AND target_id=?",
      )
      .get(kind, IdSchema.parse(id));
    if (!row) return undefined;
    const parsed = schema.safeParse(JSON.parse(String(row.payload)));
    // A record this version cannot read is not offered as a restore (worse than none: it might
    // write half of a Bot).
    if (!parsed.success) return undefined;
    return {
      sourceId: String(row.sourceId),
      fromVersion: Number(row.fromVersion),
      toVersion: Number(row.toVersion),
      payload: parsed.data,
    };
  }
  private write(
    kind: "bot" | "group",
    id: string,
    sourceIdValue: string,
    fromVersion: number,
    toVersion: number,
    payload: unknown,
  ) {
    this.db
      .prepare(
        `INSERT INTO builtin_recoveries(target_kind,target_id,source_id,from_version,to_version,payload,created_at)
         VALUES (?,?,?,?,?,?,?) ON CONFLICT(target_kind,target_id) DO UPDATE SET
         source_id=excluded.source_id,from_version=excluded.from_version,to_version=excluded.to_version,
         payload=excluded.payload,created_at=excluded.created_at`,
      )
      .run(
        kind,
        IdSchema.parse(id),
        sourceId.parse(sourceIdValue),
        fromVersion,
        toVersion,
        JSON.stringify(payload),
        new Date().toISOString(),
      );
  }
  bot(botId: string): Recovery<BotRecovery> | undefined {
    return this.read("bot", botId, BotRecoverySchema);
  }
  group(groupId: string): Recovery<GroupRecovery> | undefined {
    return this.read("group", groupId, GroupRecoverySchema);
  }
  setBot(
    botId: string,
    roleId: string,
    fromVersion: number,
    toVersion: number,
    payload: BotRecovery,
  ) {
    this.write("bot", botId, roleId, fromVersion, toVersion, BotRecoverySchema.parse(payload));
  }
  setGroup(
    groupId: string,
    templateId: string,
    fromVersion: number,
    toVersion: number,
    payload: GroupRecovery,
  ) {
    this.write(
      "group",
      groupId,
      templateId,
      fromVersion,
      toVersion,
      GroupRecoverySchema.parse(payload),
    );
  }
  clear(kind: "bot" | "group", id: string) {
    this.db
      .prepare("DELETE FROM builtin_recoveries WHERE target_kind=? AND target_id=?")
      .run(kind, IdSchema.parse(id));
  }
}
