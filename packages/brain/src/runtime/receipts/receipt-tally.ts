import {
  type ChangesTurn,
  RECEIPT_BUCKETS,
  RECEIPT_FILES,
  type ReceiptBuckets,
  type RunReceipt,
} from "@pibot/protocol-base";
import type { ReceiptAuditRow } from "@pibot/storage";

/** Counts per key; the receipt keeps the largest few and folds the rest into `others`. */
export class Tally {
  private readonly counts = new Map<string, number>();
  add(key: string | undefined, amount = 1) {
    const name = key?.trim().slice(0, 300);
    if (!name || amount <= 0) return;
    this.counts.set(name, (this.counts.get(name) ?? 0) + amount);
  }
  rename(names: ReadonlyMap<string, string>) {
    const next = new Tally();
    for (const [key, value] of this.counts) next.add(names.get(key) ?? key, value);
    return next;
  }
  keys() {
    return [...this.counts.keys()];
  }
  buckets(): ReceiptBuckets {
    const sorted = [...this.counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return {
      total: sorted.reduce((sum, [, value]) => sum + value, 0),
      items: sorted.slice(0, RECEIPT_BUCKETS).map(([key, count]) => ({ key, count })),
      others: Math.max(0, sorted.length - RECEIPT_BUCKETS),
    };
  }
}

/** The last two folder names of a path: enough to tell inputs apart without a full tree. */
export function folderOf(path: string | undefined) {
  if (!path) return undefined;
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.slice(-3, -1).join("/") || "/";
}

export interface AuditTotals {
  files: Tally;
  web: Tally;
  searches: Tally;
  connectors: Tally;
  phone: Tally;
  messages: number;
  written: Set<string>;
  attachments: number;
  images: number;
  commands: number;
  failedCommands: number;
  sentDrafts: number;
  delegated: number;
  blocked: number;
  check: string | null;
}

/** One pass over the run's audit rows (already filtered to the receipt kinds, in time order). */
export function tallyAudit(rows: readonly ReceiptAuditRow[]): AuditTotals {
  const totals: AuditTotals = {
    files: new Tally(),
    web: new Tally(),
    searches: new Tally(),
    connectors: new Tally(),
    phone: new Tally(),
    messages: 0,
    written: new Set(),
    attachments: 0,
    images: 0,
    commands: 0,
    failedCommands: 0,
    sentDrafts: 0,
    delegated: 0,
    blocked: 0,
    check: null,
  };
  for (const { kind, detail } of rows) {
    switch (kind) {
      case "file.read":
        totals.files.add(folderOf(detail.path));
        break;
      case "web.fetched":
        totals.web.add(detail.domain);
        break;
      case "search.sent":
        totals.searches.add(detail.providerName ?? detail.providerId ?? "search");
        break;
      case "connector.called":
        if (detail.reasonCode === "connector_call_done")
          totals.connectors.add(
            detail.capabilityId
              ? `${detail.capabilityId}\0${detail.connectorId ?? "connector"}`
              : detail.connectorId,
          );
        if (detail.reasonCode === "draft_sent") totals.sentDrafts++;
        break;
      case "phone.data_read":
        if (detail.reasonCode === "allowed") totals.phone.add(detail.phoneData, detail.itemCount);
        break;
      case "messages.read":
        totals.messages += detail.messageCount ?? 0;
        break;
      case "exec.finished":
        // Only the Bot's own commands; other exec rows (tool discovery, browser checks) are not
        // commands even though they share the kind.
        if (detail.toolName !== "run_command" || !detail.toolCallId) break;
        totals.commands++;
        if (detail.exitCode !== 0 || detail.timedOut || detail.stopped) totals.failedCommands++;
        break;
      // A background command is one command: counted when it starts, failed if it ends failing.
      case "exec.background.started":
        totals.commands++;
        break;
      case "exec.background.stopped":
        if (detail.reasonCode === "failed") totals.failedCommands++;
        break;
      case "file.written":
        if (detail.path) totals.written.add(detail.path);
        break;
      case "file.sent":
        totals.attachments++;
        break;
      case "image.finished":
        if (detail.reasonCode === "done") totals.images += detail.imageCount ?? 1;
        break;
      case "collaboration.queued":
        if (
          !detail.internal &&
          (detail.collaborationAction === "assign" || detail.collaborationAction === "ask")
        )
          totals.delegated++;
        break;
      case "policy.denied":
        totals.blocked++;
        break;
      case "autocheck.finished":
        totals.check = detail.reasonCode ?? null;
        break;
    }
  }
  return totals;
}

/** Files the run changed, from its recorded turn (line counts) or, without it, the audit paths. */
export function receiptOutputs(
  turn: ChangesTurn | undefined,
  totals: AuditTotals,
): Omit<RunReceipt["outputs"], "attachments" | "images"> {
  if (turn) {
    const files = turn.files.map((file) => ({
      path: file.displayPath.slice(0, 1024),
      kind: file.kind,
      added: file.added,
      removed: file.removed,
    }));
    return {
      files: files.slice(0, RECEIPT_FILES),
      filesTotal: turn.total,
      added: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
      removed: files.reduce((sum, file) => sum + (file.removed ?? 0), 0),
    };
  }
  const paths = [...totals.written];
  return {
    files: paths.slice(0, RECEIPT_FILES).map((path) => ({
      path: path.slice(0, 1024),
      kind: "modify" as const,
      added: null,
      removed: null,
    })),
    filesTotal: paths.length,
    added: 0,
    removed: 0,
  };
}
