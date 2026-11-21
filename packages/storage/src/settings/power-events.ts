import type { DatabaseSync } from "node:sqlite";
import {
  CanonicalTimeSchema,
  type Page,
  PageSchema,
  type PowerEvent,
  PowerEventSchema,
} from "@pibot/protocol-base";
export class PowerEventsRepo {
  constructor(private readonly db: DatabaseSync) {}
  append(event: PowerEvent) {
    const e = PowerEventSchema.parse(event),
      old = this.db.prepare("SELECT id,kind,at FROM power_events WHERE id=?").get(e.id);
    if (old && (old.kind !== e.kind || old.at !== e.at))
      throw new TypeError("Power event identity conflict");
    return (
      this.db
        .prepare("INSERT INTO power_events(id,kind,at) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING")
        .run(e.id, e.kind, e.at).changes > 0
    );
  }
  list(from: string, to: string, page: Page = {}) {
    CanonicalTimeSchema.parse(from);
    CanonicalTimeSchema.parse(to);
    if (from >= to) throw new TypeError("Invalid power interval");
    const { before, limit = 50 } = PageSchema.parse(page),
      cursor = before
        ? this.db
            .prepare("SELECT at FROM power_events WHERE id=? AND at>=? AND at<?")
            .get(before, from, to)
        : undefined;
    if (before && !cursor) return [];
    return this.db
      .prepare(
        "SELECT id,kind,at FROM power_events WHERE at>=? AND at<? AND (? IS NULL OR at<? OR (at=? AND id<?)) ORDER BY at DESC,id DESC LIMIT ?",
      )
      .all(
        from,
        to,
        before ?? null,
        cursor?.at == null ? null : String(cursor.at),
        cursor?.at == null ? null : String(cursor.at),
        before ?? null,
        limit,
      )
      .map((r) => PowerEventSchema.parse(r));
  }
  contextBefore(from: string) {
    CanonicalTimeSchema.parse(from);
    const row = this.db
      .prepare(
        "SELECT id,kind,at FROM power_events WHERE at<? AND kind IN ('suspend','resume','start') ORDER BY at DESC,id DESC LIMIT 1",
      )
      .get(from);
    const event = row ? PowerEventSchema.parse(row) : null;
    return {
      state: event
        ? event.kind === "suspend"
          ? ("suspended" as const)
          : ("awake" as const)
        : ("unknown" as const),
      event,
    };
  }
  prune(now = new Date().toISOString()) {
    CanonicalTimeSchema.parse(now);
    return Number(
      this.db
        .prepare("DELETE FROM power_events WHERE at<?")
        .run(new Date(Date.parse(now) - 14 * 24 * 60 * 60 * 1000).toISOString()).changes,
    );
  }
}
