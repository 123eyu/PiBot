import type { ChatPeer } from "@pibot/client-core";
import type { BackgroundCommand } from "@pibot/protocol";

interface Scope {
  conversationId: string;
  botId?: string;
  groupId?: string;
}

/** At most one recent page and one exact lookup; missing history remains explicitly missing. */
export async function loadBackgroundResults(
  peer: Pick<ChatPeer, "call">,
  ids: readonly string[],
  scope: Scope,
  signal: AbortSignal,
) {
  const wanted = [...new Set(ids)].slice(0, 32);
  const found = new Map<string, BackgroundCommand>();
  const filters = scope.groupId ? { groupId: scope.groupId } : { botId: scope.botId };
  const page = async (missing?: string[]) => {
    signal.throwIfAborted();
    try {
      const rows = await peer.call(
        "backgroundCommands.page",
        {
          state: "ended",
          limit: 100,
          ...filters,
          ...(missing ? { ids: missing } : {}),
        },
        { signal, timeoutMs: 20_000 },
      );
      signal.throwIfAborted();
      for (const row of rows) {
        if (
          wanted.includes(row.id) &&
          row.status !== "running" &&
          row.conversationId === scope.conversationId &&
          (!scope.botId || row.botId === scope.botId) &&
          (!scope.groupId || row.groupId === scope.groupId)
        )
          found.set(row.id, row);
      }
    } catch {
      signal.throwIfAborted();
      // An unavailable/pruned record is not a completed lookup; UI reports the missing count.
    }
  };
  await page();
  const missing = wanted.filter((id) => !found.has(id));
  if (missing.length) await page(missing);
  return {
    rows: wanted.flatMap((id) => {
      const row = found.get(id);
      return row ? [row] : [];
    }),
    missing: wanted.length - found.size,
  };
}
