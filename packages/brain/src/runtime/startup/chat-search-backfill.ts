import type { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "@pibot/observability";
import { ChatSearchIndex, configureChatSearchRedactor } from "@pibot/storage";
import type { BrainRedactor } from "../../core/privacy.ts";

const FIRST_RETRY_MS = 2 * 60_000;
const MAX_RETRY_MS = 30 * 60_000;

export function startChatSearchBackfill(
  db: DatabaseSync,
  redactor: BrainRedactor,
  logger: Logger,
  ready: (signal: AbortSignal) => Promise<void>,
) {
  const controller = new AbortController();
  const { signal } = controller;
  const index = new ChatSearchIndex(db);
  const work = async () => {
    // Yield before touching SQLite so the first backfill page does not hold up startup.
    await delay(0, undefined, { signal, ref: false });
    let retryMs = FIRST_RETRY_MS;
    while (!signal.aborted) {
      try {
        await ready(AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
        break;
      } catch {
        if (signal.aborted) return;
        // Keyring access can prompt the user. Space retries out while indexing remains blocked.
        logger.warn(JSON.stringify({ module: "chat_search", event: "redaction_unavailable" }));
        await delay(retryMs, undefined, { signal, ref: false });
        retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
      }
    }
    signal.throwIfAborted();
    configureChatSearchRedactor(db, (text) => redactor.redact(text));
    while (!index.backfillBatch(signal).done) await delay(1, undefined, { signal, ref: false });
  };
  const settled = work().catch(() => {
    // Do not log driver errors: the diagnostic must not contain a query or message body.
    if (!signal.aborted)
      logger.warn(JSON.stringify({ module: "chat_search", event: "backfill_deferred" }));
  });
  return {
    async stop() {
      controller.abort();
      await settled;
    },
  };
}
