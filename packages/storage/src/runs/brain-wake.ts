import type { DatabaseSync } from "node:sqlite";
import { CanonicalTimeSchema } from "@pibot/protocol-base";

/**
 * Brain standby facts the kernel owns: change revision, live runs or tool calls, the earliest
 * approval expiry. Metadata only: no instructions, messages, credentials or new persistent state.
 * Scheduled work of a capability (routines) is reported by that capability.
 */
export class BrainWakeRepo {
  constructor(private readonly db: DatabaseSync) {}
  revision() {
    return Number(this.db.prepare("SELECT total_changes() AS n").get()?.n);
  }
  hasWork() {
    return [
      "SELECT 1 FROM runs WHERE status IN ('queued','running','waiting') LIMIT 1",
      "SELECT 1 FROM tool_calls WHERE status='running' LIMIT 1",
    ].some((sql) => !!this.db.prepare(sql).get());
  }
  firstApproval() {
    const row = this.db
      .prepare("SELECT MIN(expires_at) AS at FROM approvals WHERE status='pending'")
      .get();
    return row?.at == null ? null : CanonicalTimeSchema.parse(row.at);
  }
}
