import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { loadPiSdk } from "../runtime/pi-sdk.ts";

export interface RetrySessionInput {
  sessionDir: string;
  sessionFile: string;
  boundary?: string;
  startedAt: string;
  finishedAt: string;
  signal: AbortSignal;
}
const header = z.object({
  type: z.literal("session"),
  version: z.literal(3),
  id: z.string(),
  cwd: z.string(),
});
const node = z.object({ type: z.string(), id: z.string().min(1), parentId: z.string().nullable() });
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

function parseSessionLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    // Native JSON errors can echo the session's private text into the RPC error log.
    throw new Error("retry_session_unavailable");
  }
}

/** Read a pinned, bounded v3 file before using the SDK's synchronous, potentially migrating open. */
async function snapshot(input: RetrySessionInput) {
  const { signal } = input;
  signal.throwIfAborted();
  const root = resolve(input.sessionDir),
    file = resolve(input.sessionFile);
  // Identity checks read bigint stats: number inodes lose precision on NTFS (see
  // execution core/file-identity.ts), letting a neighbouring entry pass as the same one.
  const directory = await lstat(root, { bigint: true }),
    path = await lstat(file, { bigint: true });
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (await realpath(root)) !== root ||
    dirname(file) !== root ||
    (await realpath(file)) !== file
  )
    throw new Error("retry_session_unavailable");
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > 50_000_000n ||
      before.ino !== path.ino ||
      before.dev !== path.dev
    )
      throw new Error("retry_session_unavailable");
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const read = await handle.read(bytes, offset, Math.min(32768, bytes.length - offset), offset);
      if (!read.bytesRead) throw new Error("retry_session_changed");
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true }),
      current = await lstat(file, { bigint: true }),
      parent = await lstat(root, { bigint: true });
    for (const info of [after, current])
      if (
        !info.isFile() ||
        info.nlink !== 1n ||
        info.dev !== before.dev ||
        info.ino !== before.ino ||
        info.size !== before.size ||
        info.mtimeMs !== before.mtimeMs ||
        info.ctimeMs !== before.ctimeMs
      )
        throw new Error("retry_session_changed");
    if (
      parent.dev !== directory.dev ||
      parent.ino !== directory.ino ||
      parent.isSymbolicLink() ||
      (await realpath(root)) !== root ||
      (await realpath(file)) !== file
    )
      throw new Error("retry_session_changed");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.endsWith("\n")) throw new Error("retry_session_unavailable");
    const lines = text.trimEnd().split("\n");
    if (lines.length > 100001) throw new Error("retry_session_limit");
    const first = header.parse(parseSessionLine(lines.shift() ?? ""));
    const ids = new Set<string>();
    for (const line of lines) {
      signal.throwIfAborted();
      if (line.length > 2_000_000) throw new Error("retry_session_limit");
      const value = node.parse(parseSessionLine(line));
      if (ids.has(value.id) || (value.parentId !== null && !ids.has(value.parentId)))
        throw new Error("retry_session_unavailable");
      ids.add(value.id);
    }
    return { file, root, hash: digest(bytes), cwd: first.cwd };
  } finally {
    await handle.close();
  }
}
export async function inspectRetrySession(input: RetrySessionInput) {
  input.signal.throwIfAborted();
  // Retry is reachable from the UI before any model operation has loaded the SDK.
  const { SessionManager } = await loadPiSdk();
  input.signal.throwIfAborted();
  // Loading can take seconds; take the checked file snapshot afterwards, next to the SDK open.
  const source = await snapshot(input);
  input.signal.throwIfAborted();
  const manager = SessionManager.open(source.file, source.root);
  const branch = manager.getBranch();
  let boundary = input.boundary;
  if (boundary) {
    if (
      !branch.some(
        (entry) =>
          entry.id === boundary &&
          entry.type === "custom" &&
          entry.customType === "pibot_retry_boundary",
      )
    )
      throw new Error("retry_boundary_unavailable");
  } else {
    // Legacy runs identify their initial input by the SDK timestamp inside the exclusive run,
    // never by message text. Appended/automatic input is not accepted as an initial user run.
    const users = branch.filter(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "user" &&
        entry.message.timestamp >= Date.parse(input.startedAt) &&
        entry.message.timestamp <= Date.parse(input.finishedAt),
    );
    if (!users.length) throw new Error("retry_boundary_unavailable");
    boundary = users[0]?.parentId ?? undefined;
    if (!boundary) throw new Error("retry_boundary_unavailable");
  }
  return { hash: source.hash, boundary };
}
export async function forkRetrySession(input: RetrySessionInput & { expectedHash: string }) {
  input.signal.throwIfAborted();
  const { SessionManager } = await loadPiSdk();
  input.signal.throwIfAborted();
  const checked = await inspectRetrySession(input);
  if (checked.hash !== input.expectedHash) throw new Error("retry_session_changed");
  input.signal.throwIfAborted();
  // The checked snapshot stays adjacent to the synchronous SDK open/fork, never another import.
  const manager = SessionManager.open(resolve(input.sessionFile), resolve(input.sessionDir));
  const file = manager.createBranchedSession(checked.boundary);
  if (!file || dirname(file) !== resolve(input.sessionDir) || file === resolve(input.sessionFile))
    throw new Error("retry_session_unavailable");
  const discard = () => rm(file, { force: true });
  try {
    // pi defers its first write until a conversation exists. Persist its public branch output
    // explicitly for retrying the first message, whose prefix contains metadata only.
    if (
      !(await lstat(file).catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      }))
    ) {
      await writeFile(
        file,
        `${[manager.getHeader(), ...manager.getEntries()].map((value) => JSON.stringify(value)).join("\n")}\n`,
        { flag: "wx", mode: 0o600 },
      );
    }
    await chmod(file, 0o600);
    input.signal.throwIfAborted();
    return { sessionFile: file, discard };
  } catch (error) {
    await discard();
    throw error;
  }
}
