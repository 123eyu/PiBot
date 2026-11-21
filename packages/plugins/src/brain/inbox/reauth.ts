import type { InboxSource } from "@pibot/storage";

/** Enabled connections whose authorization lapsed: one inbox item each until reauthorized. */
export const connectorAuthInboxSource: InboxSource = {
  select:
    "SELECT 'connector_auth',id,updated_at,NULL FROM connectors WHERE enabled=1 AND status='needs_auth'",
  counts: {
    connector_auth: "SELECT COUNT(*) FROM connectors WHERE enabled=1 AND status='needs_auth'",
  },
  item: (row, _context, db) => {
    const connector = db
      .prepare(
        "SELECT name,status_detail_code FROM connectors WHERE id=? AND enabled=1 AND status='needs_auth'",
      )
      .get(row.id);
    return {
      connectorId: row.id,
      name: connector?.name ?? "",
      reason: connector?.status_detail_code ?? null,
    };
  },
};
