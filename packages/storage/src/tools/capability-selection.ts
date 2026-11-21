import type { DatabaseSync } from "node:sqlite";
import {
  type CapabilityId,
  CapabilityIdSchema,
  type CapabilityImpl,
  CapabilityImplSchema,
  type CapabilityScope,
  CapabilityScopeSchema,
} from "@pibot/protocol-base";

export interface CapabilitySelection {
  scope: CapabilityScope;
  scopeId: string;
  capabilityId: CapabilityId;
  impl: CapabilityImpl;
  updatedAt: string;
}

function parseSelection(row: Record<string, unknown>): CapabilitySelection {
  return {
    scope: CapabilityScopeSchema.parse(row.scope),
    scopeId: String(row.scope_id),
    capabilityId: CapabilityIdSchema.parse(row.capability_id),
    impl: CapabilityImplSchema.parse(row.impl),
    updatedAt: String(row.updated_at),
  };
}

export class CapabilitySelectionRepo {
  constructor(private readonly db: DatabaseSync) {}

  get(
    scope: CapabilityScope,
    scopeId: string,
    capabilityId: CapabilityId,
  ): CapabilitySelection | undefined {
    const row = this.db
      .prepare(
        `SELECT scope,scope_id,capability_id,impl,updated_at
        FROM capability_selection WHERE scope=? AND scope_id=? AND capability_id=?`,
      )
      .get(CapabilityScopeSchema.parse(scope), scopeId, CapabilityIdSchema.parse(capabilityId));
    return row ? parseSelection(row) : undefined;
  }

  list(scope: CapabilityScope, scopeId: string): CapabilitySelection[] {
    return this.db
      .prepare(
        `SELECT scope,scope_id,capability_id,impl,updated_at
        FROM capability_selection WHERE scope=? AND scope_id=? ORDER BY capability_id`,
      )
      .all(CapabilityScopeSchema.parse(scope), scopeId)
      .map(parseSelection);
  }

  set(
    scope: CapabilityScope,
    scopeId: string,
    capabilityId: CapabilityId,
    impl: CapabilityImpl,
  ): CapabilitySelection {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO capability_selection(scope,scope_id,capability_id,impl,updated_at)
        VALUES(?,?,?,?,?) ON CONFLICT(scope,scope_id,capability_id) DO UPDATE SET
        impl=excluded.impl,updated_at=excluded.updated_at`,
      )
      .run(
        CapabilityScopeSchema.parse(scope),
        scopeId,
        CapabilityIdSchema.parse(capabilityId),
        CapabilityImplSchema.parse(impl),
        now,
      );
    return this.get(scope, scopeId, capabilityId) as CapabilitySelection;
  }

  clear(scope: CapabilityScope, scopeId: string, capabilityId: CapabilityId): boolean {
    return (
      this.db
        .prepare(
          "DELETE FROM capability_selection WHERE scope=? AND scope_id=? AND capability_id=?",
        )
        .run(CapabilityScopeSchema.parse(scope), scopeId, CapabilityIdSchema.parse(capabilityId))
        .changes > 0
    );
  }
}
