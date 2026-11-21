import type { DatabaseSync } from "node:sqlite";
import {
  EndpointAttributesSchema,
  type EndpointCapabilityRow,
  EndpointCapabilityRowSchema,
} from "@pibot/protocol-base";
export class EndpointCapabilitiesRepo {
  constructor(private readonly db: DatabaseSync) {}
  get(endpointId: string, capabilityId: string) {
    const row = this.db
      .prepare("SELECT * FROM endpoint_capabilities WHERE endpoint_id=? AND capability_id=?")
      .get(endpointId, capabilityId);
    if (!row) return undefined;
    return {
      managed: row.user_managed === 1,
      row: EndpointCapabilityRowSchema.parse({
        endpointId: row.endpoint_id,
        capabilityId: row.capability_id,
        version: row.version,
        state: row.state,
        availability: row.availability,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        lastCalledAt: row.last_called_at,
        scope: JSON.parse(String(row.scope)),
      }),
      attributes: EndpointAttributesSchema.parse(JSON.parse(String(row.attributes))),
    };
  }
  put(
    row: EndpointCapabilityRow,
    attributes: ReturnType<typeof EndpointAttributesSchema.parse>,
    managed = this.get(row.endpointId, row.capabilityId)?.managed ?? false,
  ) {
    this.db
      .prepare(`INSERT INTO endpoint_capabilities VALUES (?,?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(endpoint_id,capability_id) DO UPDATE SET version=excluded.version,state=excluded.state,
   availability=excluded.availability,last_seen_at=excluded.last_seen_at,last_called_at=excluded.last_called_at,
   scope=excluded.scope,attributes=excluded.attributes,user_managed=excluded.user_managed`)
      .run(
        row.endpointId,
        row.capabilityId,
        row.version,
        row.state,
        row.availability,
        row.firstSeenAt,
        row.lastSeenAt,
        row.lastCalledAt,
        JSON.stringify(row.scope),
        JSON.stringify(attributes),
        managed ? 1 : 0,
      );
  }
  page(after: string, limit: number, endpointIds?: readonly string[]) {
    // Filter before LIMIT so retired endpoint history cannot hide a live device on later pages.
    const visible = endpointIds ? " AND endpoint_id IN (SELECT value FROM json_each(?))" : "";
    return this.db
      .prepare(
        `SELECT endpoint_id,capability_id FROM endpoint_capabilities WHERE endpoint_id || ':' || capability_id > ?${visible} ORDER BY endpoint_id,capability_id LIMIT ?`,
      )
      .all(...(endpointIds ? [after, JSON.stringify(endpointIds), limit] : [after, limit]))
      .map((r) => {
        const entry = this.get(String(r.endpoint_id), String(r.capability_id));
        if (!entry) throw new Error("endpoint_registry_row_missing");
        return entry;
      });
  }
}
