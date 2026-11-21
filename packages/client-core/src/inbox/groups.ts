import type { InboxItem, MethodParams, MethodResults } from "@pibot/protocol";

/** Presentation groups only: persisted source kinds and card labels keep their own identity. */
export const inboxGroups = {
  personal_todo: ["personal_todo"],
  confirmation: [
    "approval",
    "routine_approval",
    "group_plan",
    "group_plan_action",
    "user_question",
    "routine_proposal",
    "memory",
  ],
  action: ["connector_auth", "provider", "computer_handoff", "background_task"],
  routines: ["routine_missed", "routines_paused_away", "routine_trigger_error"],
} as const satisfies Record<string, readonly InboxItem["kind"][]>;

export type InboxGroup = keyof typeof inboxGroups;

export function inboxGroupMatches(group: InboxGroup | undefined, item: InboxItem): boolean {
  return !group || (inboxGroups[group] as readonly InboxItem["kind"][]).includes(item.kind);
}

export function inboxGroupCount(group: InboxGroup, counts: MethodResults["inbox.counts"]): number {
  // Drafts are already counted among approval/routine_approval, never add the draft subset.
  return inboxGroups[group].reduce((sum, kind) => sum + (counts[kind] ?? 0), 0);
}

// Match SQLite's at/kind/id BINARY ordering, including decoded non-ASCII provider IDs.
function comparePart(left: string, right: string): number {
  const a = Array.from(left, (char) => char.codePointAt(0) ?? 0);
  const b = Array.from(right, (char) => char.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta) return delta;
  }
  return a.length - b.length;
}

function newestFirst(left: InboxItem, right: InboxItem): number {
  const a = left.cursor.split("|"),
    b = right.cursor.split("|");
  for (let index = 0; index < 3; index++) {
    const first = a[index] ?? "",
      second = b[index] ?? "";
    const delta = comparePart(
      index === 2 ? decodeURIComponent(second) : second,
      index === 2 ? decodeURIComponent(first) : first,
    );
    if (delta) return delta;
  }
  return 0;
}

/** Each source's first page contains every candidate for the merged first page. */
export async function inboxGroupPage(
  load: (params: MethodParams["inbox.list"]) => Promise<InboxItem[]>,
  group: InboxGroup | undefined,
  before: string | undefined,
  signal: AbortSignal,
): Promise<InboxItem[]> {
  signal.throwIfAborted();
  const page = { limit: 50, ...(before ? { before } : {}) };
  if (!group) return load(page);
  const results = await Promise.allSettled(
    inboxGroups[group].map((kind) => load({ ...page, kind })),
  );
  signal.throwIfAborted();
  const rows: InboxItem[] = [];
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
    rows.push(...result.value);
  }
  return rows.sort(newestFirst).slice(0, page.limit);
}
