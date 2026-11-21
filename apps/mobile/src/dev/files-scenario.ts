import {
  type Message,
  type PreviewFile,
  type RemotePreviewChunk,
  type RemotePreviewRead,
  RpcError,
} from "@pibot/protocol";
import { DiffSchema, readTurnDiff, readTurnLines } from "../features/changes/calls.ts";
import { fetchPreviewFile } from "../features/files/fetch-file.ts";
import { readOfficePage } from "../features/files/office-calls.ts";
import {
  prefetchCandidates,
  prefetchFiles,
  syncConversation,
} from "../features/sync/conversation-sync.ts";
import { readRunMessages } from "../features/tasks/detail/calls.ts";
import { MobileRuntime } from "../runtime/runtime.ts";
import { cachedRead } from "../storage/cached-read.ts";
import { memoryBlobFiles } from "../storage/file-cache.ts";
import { MobileStorage } from "../storage/state.ts";
import type { LocalData, SecretData } from "../storage/types.ts";
import type { PhoneGate, ServerPeer } from "./fixture-controls.ts";
import { createDevLink } from "./fixture-link.ts";

/** The desktop's slicer (packages/remote), injected by the dev probe like the phone gate. */
export type Slicer = (dispatch: (method: "preview.read", params: unknown) => Promise<unknown>) => {
  read(input: RemotePreviewRead): Promise<RemotePreviewChunk>;
  clear(): void;
};

const binary = (size: number) => {
  const parts: string[] = ["\x89PNG\r\n\x1a\n"];
  let seed = 7;
  for (let i = 8; i < size; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    parts.push(String.fromCharCode(seed & 0xff));
  }
  return parts.join("");
};
// CJK (3 UTF-8 bytes) and an astral emoji (a surrogate pair) so slices cross both boundaries.
const text = Array.from({ length: 30_000 }, (_, i) => `第${i}行 代码 😀 line\n`).join("");
function memoryStorage(blobs: ReturnType<typeof memoryBlobFiles>) {
  const values = new Map<string, unknown>(),
    secrets = new Map<string, string>();
  const data: LocalData = {
    get: async (key) => structuredClone(values.get(key)),
    put: async (key, value) => void values.set(key, structuredClone(value)),
    removePrefix: async (prefix) => {
      for (const key of values.keys()) if (key.startsWith(prefix)) values.delete(key);
    },
    close: async () => undefined,
  };
  const secure: SecretData = {
    get: async (id) => secrets.get(id) ?? null,
    set: async (id, value) => void secrets.set(id, value),
    remove: async (id) => void secrets.delete(id),
  };
  return new MobileStorage(data, secure, blobs);
}
async function outcome(work: () => Promise<unknown>) {
  try {
    await work();
    return "accepted";
  } catch (error) {
    return error instanceof RpcError ? `${error.code}:${error.message}` : String(error);
  }
}
/**
 * File previews in memory: previews read in frame-sized slices through the desktop's real phone gate
 * and slicer, the phone cache (revalidation, offline copy, unpair), Office pages, run diffs, task
 * messages and the background sync with prefetch. No network, no native modules.
 */
export async function runFilesScenario(gate: PhoneGate, slicer: Slicer) {
  let checks = 0;
  const check = (value: unknown, label: string) => {
    if (!value) throw new Error(`files_check_${label}`);
    checks++;
  };
  const image = { id: crypto.randomUUID(), bytes: binary(2_400_000), revision: "a".repeat(64) };
  const doc = { id: crypto.randomUUID(), text, revision: "c".repeat(64) };
  let kernelReads = 0;
  const preview = async (params: unknown): Promise<PreviewFile> => {
    kernelReads++;
    const input = params as { attachmentId?: string; expectedRevision?: string };
    const isImage = input.attachmentId === image.id;
    const revision = isImage ? image.revision : doc.revision;
    if (input.expectedRevision && input.expectedRevision !== revision)
      throw new RpcError(-32602, "preview_changed");
    return isImage
      ? { kind: "image", revision, data: btoa(image.bytes) }
      : { kind: "code", revision, data: "", text: doc.text };
  };
  const runId = crypto.randomUUID();
  const register = (server: ServerPeer) => {
    const chunks = slicer((_method, params) => preview(params));
    server.handle("remote.preview.read", (input) => chunks.read(input));
    server.handle("office.preview", async (input) => ({
      format: "docx" as const,
      revision: "d".repeat(64),
      content: {
        kind: "docx" as const,
        title: "Report",
        blocks: [{ type: "paragraph" as const, text: `Offset ${input.offset ?? 0}` }],
      },
      warnings: [],
      truncated: false,
      total: 3,
    }));
    server.handle("changes.diff", async (input) => ({
      path: input.path,
      binary: false,
      tooLarge: false,
      unavailable: null,
      added: 1,
      removed: 1,
      hunks: [
        {
          index: 0,
          header: "@@ -10,3 +10,3 @@",
          oldStart: 10,
          oldLines: 3,
          newStart: 10,
          newLines: 3,
          lines: [" a", "-b", "+B", " c"],
          digest: "e".repeat(64),
        },
      ],
    }));
    server.handle("changes.lines", async (input) => ({
      lines: Array.from({ length: input.count }, (_, i) => `line ${input.from + i}`),
      total: 40,
    }));
  };
  const blobs = memoryBlobFiles();
  const fixture = createDevLink(gate, register),
    runtime = new MobileRuntime(memoryStorage(blobs), fixture.link, 0);
  const cache = runtime.storage.files;
  try {
    await runtime.initialize();
    await runtime.preparePair("development-qr", "Development phone");
    await runtime.savePair();
    const until = Date.now() + 5000;
    while (runtime.getSnapshot().status !== "online") {
      if (Date.now() > until) throw new Error("files_timeout");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const computerId = fixture.computer.id;
    const messageId = crypto.randomUUID();
    const read = (attachmentId: string, name: string, online = true) =>
      fetchPreviewFile(runtime, cache, {
        computerId,
        online,
        source: { attachmentId, messageId },
        name,
      });
    let start = fixture.calls.length;
    const first = await read(image.id, "photo.png");
    const imageSlices = fixture.calls.length - start;
    check(imageSlices > 1, "image_sliced");
    check((await cache.readText(first.entry)) === image.bytes, "image_bytes");
    start = fixture.calls.length;
    const textFile = await read(doc.id, "notes.ts");
    const textSlices = fixture.calls.length - start;
    check(textSlices > 1 && (await cache.readText(textFile.entry)) === text, "text_exact");
    start = fixture.calls.length;
    const again = await read(image.id, "photo.png");
    check(fixture.calls.length - start === 1 && !again.stale, "revalidated_unchanged");
    image.revision = "b".repeat(64);
    image.bytes = binary(300_000);
    const changed = await read(image.id, "photo.png");
    check(
      changed.entry.revision === image.revision &&
        (await cache.readText(changed.entry)) === image.bytes,
      "changed_refetched",
    );
    const office = await readOfficePage(runtime, cache, {
      computerId,
      online: true,
      source: { attachmentId: crypto.randomUUID(), messageId },
      limit: 30,
      offset: 0,
    });
    check(office.page.content.kind === "docx", "office_page");
    const target = { conversationKey: `dm:${fixture.botId}` };
    const diff = await cachedRead(
      cache,
      { computerId, online: true, key: `diff:${runId}:a.ts`, schema: DiffSchema },
      () => readTurnDiff(runtime, target, runId, "a.ts"),
    );
    const lines = await readTurnLines(runtime, { target, runId, path: "a.ts", from: 1, count: 9 });
    check(diff.value.hunks.length === 1 && lines.lines.length === 9, "diff_lines");
    // A conversation with a run and attachments, for task detail and the background sync.
    const now = new Date().toISOString();
    const base = {
      conversationId: fixture.topicId,
      runId,
      errorCode: null,
      usage: null,
      createdAt: now,
      updatedAt: now,
    };
    const attachment = (id: string, name: string, size: number) => ({
      id,
      kind: name.endsWith(".png") ? ("image" as const) : ("file" as const),
      name,
      mimeType: "application/octet-stream",
      size,
    });
    const sent: Message[] = [
      { ...base, id: crypto.randomUUID(), role: "user", content: "Make a chart", status: "done" },
      {
        ...base,
        id: messageId,
        botId: fixture.botId,
        role: "assistant",
        content: "Here it is",
        status: "done",
        attachments: [
          attachment(crypto.randomUUID(), "fresh.png", 1000),
          attachment(crypto.randomUUID(), "huge.png", 9_000_000),
        ],
      },
    ];
    fixture.history.push(...sent);
    const task = await readRunMessages(runtime, {
      runId,
      botId: fixture.botId,
      conversationId: fixture.topicId,
    });
    check(task.request?.content === "Make a chart" && task.reply?.id === messageId, "task");
    const synced = await syncConversation(
      runtime,
      runtime.storage,
      computerId,
      { kind: "bot", id: fixture.botId },
      new AbortController().signal,
    );
    const candidates = prefetchCandidates(synced);
    check(candidates.length === 1, "prefetch_small_only");
    const fetched = await prefetchFiles(
      runtime,
      cache,
      computerId,
      candidates,
      new AbortController().signal,
    );
    const cachedHistory = await runtime.storage.history(
      computerId,
      JSON.stringify({ botId: fixture.botId, topicId: fixture.topicId }),
    );
    check(cachedHistory.length === synced.length, "history_cached");
    const refused = {
      "preview.open": await outcome(() =>
        runtime.call("preview.open", { attachmentId: image.id, messageId }),
      ),
      "office.open": await outcome(() =>
        runtime.call("office.open", { attachmentId: image.id, messageId }),
      ),
      "changes.diff(uncommitted)": await outcome(() =>
        runtime.call("changes.diff", { ...target, path: "a.ts", scope: "uncommitted" }),
      ),
      "office.preview(limit 200)": await outcome(() =>
        runtime.call("office.preview", {
          attachmentId: image.id,
          messageId,
          requestId: crypto.randomUUID(),
          limit: 200,
        }),
      ),
      "changes.lines(count 2000)": await outcome(() =>
        runtime.call("changes.lines", {
          ...target,
          path: "a.ts",
          scope: "turn",
          runId,
          from: 1,
          count: 2000,
        }),
      ),
    };
    check(
      Object.values(refused).every((value) => value !== "accepted"),
      "refused",
    );
    const largestFrame = Math.max(...fixture.frames);
    check(largestFrame < 900_000, "frames_fit");
    await runtime.setForeground(false);
    const offline = await read(image.id, "photo.png", false);
    const offlineDiff = await cachedRead(
      cache,
      { computerId, online: false, key: `diff:${runId}:a.ts`, schema: DiffSchema },
      () => Promise.reject(new Error("offline_read")),
    );
    check(offline.stale && offlineDiff.stale, "offline_cached");
    const stored = blobs.stored();
    await runtime.forget(computerId);
    check(
      blobs.stored() === 0 && !(await cache.peek(computerId, `attachment:${image.id}`)),
      "unpair_clears",
    );
    const used = [...new Set(fixture.calls)];
    return {
      checks,
      sliced: { imageSlices, textSlices, kernelReads },
      largestFrame,
      allowed: used.filter((m) => gate.isPhoneMethod(m)),
      refused,
      prefetched: fetched,
      blobsBeforeUnpair: stored,
      networkRequests: 0,
    };
  } finally {
    await runtime.dispose();
    fixture.disconnect();
  }
}
