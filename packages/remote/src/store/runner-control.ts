import type { DatabaseSync } from "node:sqlite";
import {
  type PhoneControlGrant,
  PhoneControlGrantSchema,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol-base";

export class RunnerControlRepo {
  constructor(private readonly db: DatabaseSync) {}
  get(phone: string, runner: string) {
    const row = this.db
      .prepare("SELECT * FROM remote_runner_phone_control WHERE phone_id=? AND runner_id=?")
      .get(phone, runner);
    return {
      enabled: row ? row.enabled === 1 : true,
      revision: Number(row?.revision ?? 0),
      delivered: Number(row?.delivered_revision ?? 0),
      grant: row?.grant_json
        ? PhoneControlGrantSchema.parse(JSON.parse(String(row.grant_json)))
        : undefined,
    };
  }
  save(phone: string, runner: string, grant: PhoneControlGrant) {
    this.db
      .prepare(`INSERT INTO remote_runner_phone_control(phone_id,runner_id,enabled,revision,grant_json) VALUES(?,?,?,?,?)
      ON CONFLICT(phone_id,runner_id) DO UPDATE SET enabled=excluded.enabled,revision=excluded.revision,grant_json=excluded.grant_json`)
      .run(phone, runner, grant.body.enabled ? 1 : 0, grant.body.revision, JSON.stringify(grant));
  }
  switch(phone: string, runner: string, enabled: boolean, expected: number) {
    if (this.get(phone, runner).revision !== expected)
      throw new RpcError(RpcErrorCodes.busy, "runner_authorization_changed");
    this.db
      .prepare(`INSERT INTO remote_runner_phone_control(phone_id,runner_id,enabled) VALUES(?,?,?)
      ON CONFLICT(phone_id,runner_id) DO UPDATE SET enabled=excluded.enabled`)
      .run(phone, runner, enabled ? 1 : 0);
  }
  delivered(phone: string, runner: string, revision: number) {
    this.db
      .prepare(
        "UPDATE remote_runner_phone_control SET delivered_revision=? WHERE phone_id=? AND runner_id=? AND revision=?",
      )
      .run(revision, phone, runner, revision);
  }
  forRunner(runner: string, after = "") {
    return this.db
      .prepare(
        "SELECT phone_id FROM remote_runner_phone_control WHERE runner_id=? AND phone_id>? ORDER BY phone_id LIMIT 100",
      )
      .all(runner, after)
      .map((r) => String(r.phone_id));
  }
}
