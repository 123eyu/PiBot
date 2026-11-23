// Bound adapter output and page writes so the brain remains responsive during large imports.
import { setImmediate as yieldToLoop } from "node:timers/promises";
import type { BrainRedactor } from "@pibot/brain/kit";
import type { ImportPreview, ImportStatus } from "@pibot/import-contract";
import type { ImportStore } from "../store/index.ts";
import {
  type ImportAdapter,
  ImportFailure,
  type ImportInput,
  ImportRecordSchema,
  PreviewRecordSchema,
} from "./adapter.ts";

const PAGE_RECORDS = 32;
const MAX_TOPICS = 20_000;
const MAX_MESSAGES = 500_000;
const MAX_TEXT_BYTES = 512 * 1024 * 1024;

class Summary {
  readonly counts = { topics: 0, messages: 0 };
  from: string | null = null;
  through: string | null = null;

  include(record: { kind: "topic" | "message"; createdAt: string; updatedAt?: string }) {
    const { kind, createdAt, updatedAt = createdAt } = record;
    if (kind === "topic") {
      if (updatedAt < createdAt || ++this.counts.topics > MAX_TOPICS)
        throw new ImportFailure(updatedAt < createdAt ? "format" : "limit");
    } else if (!this.counts.topics || ++this.counts.messages > MAX_MESSAGES) {
      throw new ImportFailure(this.counts.topics ? "limit" : "format");
    }
    if (!this.from || createdAt < this.from) this.from = createdAt;
    if (!this.through || updatedAt > this.through) this.through = updatedAt;
  }
}

export async function summarize(adapter: ImportAdapter, input: ImportInput, signal: AbortSignal) {
  const summary = new Summary();
  let pending = 0;
  for await (const record of adapter.preview(input, signal)) {
    signal.throwIfAborted();
    const parsed = PreviewRecordSchema.safeParse(record);
    if (!parsed.success) throw new ImportFailure("format");
    summary.include(parsed.data);
    if (++pending % PAGE_RECORDS === 0) await yieldToLoop(undefined, { signal });
  }
  signal.throwIfAborted();
  return { ...summary.counts, from: summary.from, through: summary.through };
}

type WriteOptions = {
  adapter: ImportAdapter;
  input: ImportInput;
  preview: ImportPreview;
  botId: string;
  store: ImportStore;
  redactor: BrainRedactor;
  signal: AbortSignal;
  progress: (counts: Pick<ImportStatus, "topics" | "messages">) => void;
};

export async function writeRecords(opts: WriteOptions) {
  const { adapter, input, preview, botId, store, signal, progress } = opts;
  const { importId, source } = preview;
  const summary = new Summary();
  const page: Array<() => void> = [];
  let conversationId: string | undefined;
  let bytes = 0;
  function flush() {
    signal.throwIfAborted();
    if (!page.length) return;
    store.page(
      importId,
      () => {
        if (!store.availableBot(botId)) throw new ImportFailure("target");
        for (const write of page) write();
      },
      summary.counts,
    );
    page.length = 0;
    progress(summary.counts);
  }
  for await (const record of adapter.read(input, signal)) {
    signal.throwIfAborted();
    const parsed = ImportRecordSchema.safeParse(record);
    if (!parsed.success) throw new ImportFailure("format");
    const item = parsed.data;
    summary.include(item);
    if (summary.counts.topics > preview.topics || summary.counts.messages > preview.messages)
      throw new ImportFailure("source_changed");
    bytes += Buffer.byteLength(item.kind === "topic" ? item.title : item.text);
    if (bytes > MAX_TEXT_BYTES) throw new ImportFailure("limit");
    if (item.kind === "topic") {
      const title = redactImportText(opts.redactor, item.title).slice(0, 200);
      page.push(() => {
        conversationId = store.addTopic(importId, botId, source, { ...item, title });
      });
    } else {
      const text = redactImportText(opts.redactor, item.text);
      page.push(() => {
        if (!conversationId) throw new ImportFailure("format");
        store.addMessage(importId, botId, conversationId, { ...item, text });
      });
    }
    if (page.length < PAGE_RECORDS) continue;
    flush();
    await yieldToLoop(undefined, { signal });
  }
  if (
    summary.counts.topics !== preview.topics ||
    summary.counts.messages !== preview.messages ||
    summary.from !== preview.from ||
    summary.through !== preview.through
  )
    throw new ImportFailure("source_changed");
  flush();
}

function redactImportText(redactor: BrainRedactor, input: string) {
  return redactor
    .redact(input)
    .replace(
      /\b(password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token)(["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
      "$1$2[REDACTED]",
    )
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
      "[REDACTED]",
    )
    .replace(/\bBearer[ \t]+[A-Za-z0-9_./+~=-]+/gi, "Bearer [REDACTED]");
}
