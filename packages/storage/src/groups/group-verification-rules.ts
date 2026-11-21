// Optional template review hints survive import without changing the group SQL schema.
import type { DatabaseSync } from "node:sqlite";
import {
  type GroupVerification,
  type GroupVerificationRules,
  GroupVerificationRulesSchema,
  GroupVerificationSchema,
} from "@pibot/protocol-base";

const ASSIGNMENTS_KEPT = 10;

export class GroupVerificationRulesRepo {
  constructor(private readonly db: DatabaseSync) {}

  get(groupId: string): GroupVerificationRules {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(`group-verification:${groupId}`);
    return row ? GroupVerificationRulesSchema.parse(JSON.parse(String(row.value))) : {};
  }

  /**
   * The verifier the coordinator was woken to name, per source run. Several can be open in one
   * group (one per finished plan or run), so the last few are kept instead of one per group.
   */
  assignment(groupId: string, sourceRunId: string): GroupVerification | undefined {
    return this.assignments(groupId).find((facts) => facts.sourceRunId === sourceRunId);
  }

  saveAssignment(groupId: string, facts: GroupVerification) {
    const parsed = GroupVerificationSchema.parse(facts);
    const kept = [
      parsed,
      ...this.assignments(groupId).filter((item) => item.sourceRunId !== parsed.sourceRunId),
    ].slice(0, ASSIGNMENTS_KEPT);
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(`group-verification-assignment:${groupId}`, JSON.stringify(kept));
  }

  private assignments(groupId: string): GroupVerification[] {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(`group-verification-assignment:${groupId}`);
    if (!row) return [];
    const value: unknown = JSON.parse(String(row.value));
    // Rows written before several were kept hold one object.
    const list = Array.isArray(value) ? value : [value];
    return list.flatMap((item) => {
      const parsed = GroupVerificationSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });
  }

  set(groupId: string, rules: GroupVerificationRules) {
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(
        `group-verification:${groupId}`,
        JSON.stringify(GroupVerificationRulesSchema.parse(rules)),
      );
  }
}
