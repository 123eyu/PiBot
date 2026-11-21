import type { Message } from "@pibot/protocol";
import { preserveLiveReply } from "../chat/reply-delta.ts";

export async function readGroupWindow(
  read: (before?: string) => Promise<Message[]>,
  loaded: () => Message[],
  terminals: Map<
    string,
    { botId: string; runId: string; status?: Message["status"]; errorCode?: Message["errorCode"] }
  >,
  signal: AbortSignal,
) {
  let page = await read();
  let hasMore = page.length === 50;
  const ids = new Set(loaded().map((m) => m.id));
  const cursors = new Set<string>();
  // A burst may move the recent page. Fill its gap before retaining the loaded prefix.
  for (let count = 0; ids.size && hasMore && page[0] && !ids.has(page[0].id); count++) {
    const cursor = page[0].id;
    if (count === 25 || cursors.has(cursor)) throw new Error("History gap exceeds read budget");
    cursors.add(cursor);
    const older = await read(cursor);
    signal.throwIfAborted();
    hasMore = older.length === 50;
    if (!older.length) break;
    page = [...older, ...page];
  }
  const recent = new Map(page.map((m) => [m.id, m]));
  const previous = loaded();
  const positions = new Map(previous.map((m, index) => [m.id, index]));
  const repairs = new Map<string, Message>();
  let attempts = 0;
  // Repair only exact loaded identities omitted by this page, never scan all older history.
  for (const [id, identity] of terminals) {
    signal.throwIfAborted();
    const current = recent.get(id);
    if (current && current.status !== "streaming") {
      terminals.delete(id);
      continue;
    }
    const index = positions.get(id);
    const next = index === undefined ? undefined : previous[index + 1]?.id;
    if (!next || current) continue;
    if (++attempts > 1000) throw new Error("Terminal repair exceeds read budget");
    const older = await read(next);
    signal.throwIfAborted();
    const match = older.find(
      (m) => m.id === id && m.botId === identity.botId && m.runId === identity.runId,
    );
    if (match && match.status !== "streaming") {
      repairs.set(id, match);
      terminals.delete(id);
    }
  }
  signal.throwIfAborted();
  const live = loaded();
  const first = page[0];
  const overlap = first ? live.findIndex((m) => m.id === first.id) : -1;
  const prefix = overlap >= 0 ? live.slice(0, overlap) : [];
  const latest = new Map(live.map((m) => [m.id, m]));
  const messages = [...prefix.map((m) => repairs.get(m.id) ?? m), ...page].map((m) => {
    const old = latest.get(m.id);
    const terminal = terminals.get(m.id);
    if (
      m.status === "streaming" &&
      terminal?.status &&
      terminal.botId === m.botId &&
      terminal.runId === m.runId
    )
      return old && old.status !== "streaming" && old.botId === m.botId && old.runId === m.runId
        ? old
        : { ...m, status: terminal.status, errorCode: terminal.errorCode ?? null };
    if (
      m.status === "streaming" &&
      old &&
      old.status !== "streaming" &&
      old.runId === m.runId &&
      old.botId === m.botId
    )
      return old;
    // Deltas can arrive during terminal repair reads; preserve the newer live checkpoint.
    return m.status === "streaming" &&
      old?.status === "streaming" &&
      old.runId === m.runId &&
      old.botId === m.botId &&
      old.content.startsWith(m.content)
      ? preserveLiveReply(m, old)
      : m;
  });
  return { messages, hasMore: prefix.length ? undefined : hasMore };
}
