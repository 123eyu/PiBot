import type { DatabaseSync } from "node:sqlite";
import { CHATGPT_PLAN_PROVIDER } from "@pibot/models-contract/full";
import { transaction } from "@pibot/storage";
import { z } from "zod";

const OPENAI = "openai";
// Sign-in metadata that lived on the OpenAI row while the plan was its auth switch.
const PLAN_FIELDS = [
  "chatgptHostId",
  "chatgptAccount",
  "chatgptUsageLimited",
  "authState",
  "authError",
] as const;
const ConfigSchema = z.record(z.string(), z.json());

export interface ChatGPTPlanMove {
  bots: number;
  settings: number;
  credential: boolean;
}

function readConfig(db: DatabaseSync, id: string): Record<string, unknown> | null {
  const row = db.prepare("SELECT config FROM providers WHERE id = ?").get(id);
  return row ? ConfigSchema.parse(JSON.parse(String(row.config))) : null;
}

function writeConfig(db: DatabaseSync, id: string, config: Record<string, unknown>) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO providers (id, kind, config, created_at, updated_at) VALUES (?, 'builtin', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`).run(
    id,
    JSON.stringify(config),
    now,
    now,
  );
}

/**
 * The ChatGPT plan left the OpenAI row for its own provider. A user whose
 * OpenAI row was switched to the plan gets every saved OpenAI choice (Bots, Pi, the default and
 * auxiliary models) moved to the plan, keeping the model when the plan has it and the plan's
 * default otherwise; image Bots stay on OpenAI because the plan has no image models. A user on an
 * API key keeps every choice. Either way a stored plan sign-in moves with its metadata, without
 * decrypting it. Runs at startup before any model consumer; once moved, the OpenAI row no longer
 * says `oauth`, so a second run changes nothing.
 */
export function moveChatGPTPlanOffOpenAI(
  db: DatabaseSync,
  plan: { ids: readonly string[]; defaultId?: string },
): ChatGPTPlanMove | undefined {
  return transaction(db, () => {
    const openai = readConfig(db, OPENAI);
    const oldScope = `provider:${OPENAI}:oauth`;
    const newScope = `provider:${CHATGPT_PLAN_PROVIDER}:oauth`;
    const hasOld = !!db
      .prepare("SELECT 1 FROM secrets WHERE scope = ? AND name = 'credential'")
      .get(oldScope);
    const onPlan = openai?.selectedAuth === "oauth";
    if (!openai || (!onPlan && !hasOld && !PLAN_FIELDS.some((key) => key in openai)))
      return undefined;
    let credential = false;
    if (hasOld) {
      const hasNew = !!db
        .prepare("SELECT 1 FROM secrets WHERE scope = ? AND name = 'credential'")
        .get(newScope);
      // The plan's own record is newer than one left on the OpenAI row; never keep two sign-ins.
      if (hasNew) db.prepare("DELETE FROM secrets WHERE scope = ?").run(oldScope);
      else {
        db.prepare("UPDATE secrets SET scope = ? WHERE scope = ?").run(newScope, oldScope);
        credential = true;
      }
    }
    const current = readConfig(db, CHATGPT_PLAN_PROVIDER) ?? {};
    const moved: Record<string, unknown> = { ...current };
    const rest: Record<string, unknown> = { ...openai };
    for (const key of PLAN_FIELDS) {
      if (key in openai && !(key in current)) moved[key] = openai[key];
      delete rest[key];
    }
    if (onPlan) delete rest.selectedAuth;
    writeConfig(db, CHATGPT_PLAN_PROVIDER, moved);
    writeConfig(db, OPENAI, rest);
    if (!onPlan) return { bots: 0, settings: 0, credential };
    const ids = JSON.stringify(plan.ids);
    const fallback = plan.defaultId ?? null;
    const bots = db
      .prepare(
        `UPDATE bots SET model_provider = ?,
           model_id = CASE WHEN model_id IN (SELECT value FROM json_each(?)) THEN model_id
                           ELSE COALESCE(?, model_id) END
         WHERE model_provider = ? AND image_mode IS NULL`,
      )
      .run(CHATGPT_PLAN_PROVIDER, ids, fallback, OPENAI).changes;
    const settings = db
      .prepare(
        `UPDATE settings SET value = json_set(value, '$.provider', ?, '$.id',
           CASE WHEN json_extract(value, '$.id') IN (SELECT value FROM json_each(?))
                THEN json_extract(value, '$.id') ELSE COALESCE(?, json_extract(value, '$.id')) END)
         WHERE key IN ('defaultModel', 'auxiliaryModel') AND json_valid(value)
           AND json_type(value) = 'object' AND json_extract(value, '$.provider') = ?`,
      )
      .run(CHATGPT_PLAN_PROVIDER, ids, fallback, OPENAI).changes;
    return { bots: Number(bots), settings: Number(settings), credential };
  });
}
