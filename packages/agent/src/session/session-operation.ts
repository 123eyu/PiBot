import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { LocalToolCall } from "../core/types.ts";

const entrySchema = z.object({
  type: z.string(),
  id: z.string().min(1),
  parentId: z.string().nullable(),
  message: z
    .object({
      role: z.string(),
      content: z.unknown(),
      toolCallId: z.string().optional(),
      isError: z.boolean().optional(),
    })
    .optional(),
});
const callSchema = z.object({
  type: z.literal("toolCall"),
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
});

// The SDK's synchronous SessionManager.open can migrate/write. Revalidation only reads bounded v3 JSONL.
export async function readSessionOperation(input: {
  sessionDir: string;
  sessionFile: string;
  toolCallId: string;
  signal: AbortSignal;
}): Promise<LocalToolCall> {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(15000)]);
  const root = resolve(input.sessionDir),
    file = resolve(input.sessionFile);
  signal.throwIfAborted();
  // Identity checks read bigint stats: number inodes lose precision on NTFS (see
  // execution core/file-identity.ts), letting a neighbouring entry pass as the same one.
  const directory = await lstat(root, { bigint: true });
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (await realpath(root)) !== root ||
    dirname(file) !== root ||
    (await realpath(file)) !== file
  )
    throw new Error("Unmanaged routine session");
  const pathBefore = await lstat(file, { bigint: true });
  if (!pathBefore.isFile() || pathBefore.nlink !== 1n || pathBefore.size > 50000000n)
    throw new Error("Routine session must be a bounded regular file");
  signal.throwIfAborted();
  // A file can become a FIFO after lstat; nonblocking open must precede descriptor validation.
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0),
  );
  try {
    signal.throwIfAborted();
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 50000000n)
      throw new Error("Routine session budget");
    if (
      before.dev !== pathBefore.dev ||
      before.ino !== pathBefore.ino ||
      before.size !== pathBefore.size ||
      before.mtimeMs !== pathBefore.mtimeMs ||
      before.ctimeMs !== pathBefore.ctimeMs
    )
      throw new Error("Routine session changed");
    const verifyPath = async () => {
      const current = await lstat(file, { bigint: true }),
        parent = await lstat(root, { bigint: true });
      signal.throwIfAborted();
      if (
        !current.isFile() ||
        current.nlink !== 1n ||
        current.dev !== before.dev ||
        current.ino !== before.ino ||
        current.size !== before.size ||
        current.mtimeMs !== before.mtimeMs ||
        current.ctimeMs !== before.ctimeMs ||
        !parent.isDirectory() ||
        parent.isSymbolicLink() ||
        parent.dev !== directory.dev ||
        parent.ino !== directory.ino ||
        (await realpath(root)) !== root ||
        (await realpath(file)) !== file
      )
        throw new Error("Routine session changed");
      signal.throwIfAborted();
    };
    await verifyPath();
    const nodes = new Map<
      string,
      { parent: string | null; call?: LocalToolCall; executed: boolean }
    >();
    let leaf: string | null = null,
      header = false,
      pending = "",
      bytes = 0;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const consume = (line: string) => {
      if (!line.trim()) return;
      const raw = JSON.parse(line);
      if (!header) {
        z.object({
          type: z.literal("session"),
          version: z.literal(3),
          id: z.string(),
          cwd: z.string(),
        }).parse(raw);
        header = true;
        return;
      }
      const e = entrySchema.parse(raw);
      if (
        nodes.has(e.id) ||
        (e.parentId !== null && !nodes.has(e.parentId)) ||
        nodes.size >= 100000
      )
        throw new Error("Invalid session branch");
      let call: LocalToolCall | undefined;
      if (e.message?.role === "assistant" && Array.isArray(e.message.content)) {
        for (const content of e.message.content) {
          const parsed = callSchema.safeParse(content);
          if (parsed.success && parsed.data.id === input.toolCallId) {
            if (call) throw new Error("Duplicate session operation");
            call = { id: parsed.data.id, tool: parsed.data.name, input: parsed.data.arguments };
          }
        }
      }
      nodes.set(e.id, {
        parent: e.parentId,
        call,
        executed:
          e.message?.role === "toolResult" &&
          e.message.toolCallId === input.toolCallId &&
          e.message.isError !== true,
      });
      leaf = e.id;
    };
    const buffer = Buffer.alloc(32768);
    for (;;) {
      signal.throwIfAborted();
      const read = await handle.read(buffer);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (bytes > 50000000) throw new Error("Routine session budget");
      pending += decoder.decode(buffer.subarray(0, read.bytesRead), { stream: true });
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        if (newline > 2000000) throw new Error("Routine session line budget");
        consume(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      if (pending.length > 2000000) throw new Error("Routine session line budget");
    }
    pending += decoder.decode();
    if (pending.trim()) throw new Error("Undrained session tail");
    const after = await handle.stat({ bigint: true });
    if (
      !after.isFile() ||
      after.nlink !== 1n ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("Routine session changed");
    await verifyPath();
    let found: LocalToolCall | undefined;
    while (leaf !== null) {
      signal.throwIfAborted();
      const node = nodes.get(leaf);
      if (!node || node.executed || (node.call && found))
        throw new Error("Session operation already executed or ambiguous");
      if (node.call) found = node.call;
      leaf = node.parent;
    }
    if (!header || !found) throw new Error("Session operation missing");
    return found;
  } finally {
    await handle.close();
  }
}
