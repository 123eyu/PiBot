import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type ExactStatIdentity,
  fileIdentity,
  matchesFileIdentity,
  sameFile,
} from "../core/file-identity.ts";
import { within, writablePath } from "../core/paths.ts";
import {
  BinaryWriteError,
  type BinaryWriteReceipt,
  ExecError,
  type ImageBinaryIdentity,
  type ImageBinaryWriteOptions,
} from "../core/types.ts";
import { verifyWorkspace } from "../sandbox/workspace.ts";

const maxImageBytes = 10 * 1024 * 1024;

function identityKey(identity: ImageBinaryIdentity): string {
  if (
    !identity.runId ||
    !identity.attachmentId ||
    identity.runId.length > 200 ||
    identity.attachmentId.length > 200 ||
    !["png", "jpg", "webp", "gif"].includes(identity.extension)
  )
    throw new ExecError("invalid_input");
  return createHash("sha256")
    .update(JSON.stringify([identity.runId, identity.attachmentId]))
    .digest("hex");
}

export function imageExportFileName(identity: ImageBinaryIdentity): string {
  return `pibot-image-${identityKey(identity)}.${identity.extension}`;
}

/** Publish with link rather than rename: even a last-moment competing target is never overwritten. */
export async function writeImageBinary(options: ImageBinaryWriteOptions) {
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]);
  // Revalidation may tighten current permissions, but cannot widen this approved snapshot by mutation.
  const context = {
    ...options,
    signal,
    rootIdentities: options.rootIdentities?.map((identity) => ({ ...identity })),
    writeRoots: [...options.writeRoots],
    denyWriteRoots: options.denyWriteRoots ? [...options.denyWriteRoots] : undefined,
    previous: options.previous ? { ...options.previous } : undefined,
  };
  const key = identityKey(options);
  if (
    !(options.bytes instanceof Uint8Array) ||
    !options.bytes.byteLength ||
    options.bytes.byteLength > maxImageBytes ||
    !options.rootIdentities?.length ||
    !options.expectedPath ||
    typeof options.revalidate !== "function"
  )
    throw new ExecError("invalid_input");
  signal.throwIfAborted();
  // Snapshot caller-owned memory before the first await; asynchronous approvals must happen in brain.
  const bytes = Buffer.from(options.bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const cwd = resolve(options.cwd);
  if (!options.rootIdentities.some((identity) => within(identity.canonicalPath, cwd)))
    throw new ExecError("outside_workplace");
  const target = join(cwd, imageExportFileName(options));
  await verifyWorkspace(context.rootIdentities, signal);
  const parent = await lstat(cwd, { bigint: true });
  if (!parent.isDirectory() || parent.isSymbolicLink() || (await realpath(cwd)) !== cwd)
    throw new ExecError("outside_workplace");
  async function check(checkSignal = signal) {
    await verifyWorkspace(context.rootIdentities, checkSignal);
    const current = await lstat(cwd, { bigint: true });
    if (
      (await writablePath(target, cwd, context.writeRoots, context.denyWriteRoots)) !== target ||
      target !== context.expectedPath ||
      !sameFile(parent, current) ||
      (await realpath(cwd)) !== cwd
    )
      throw new ExecError("outside_workplace");
    checkSignal.throwIfAborted();
  }
  await check();
  // Receipts are persisted and re-checked on retry, so they use the canonical identity encoding.
  const parentIdentity = fileIdentity(parent);
  const receipt = (stat: ExactStatIdentity): BinaryWriteReceipt => ({
    path: target,
    identityKey: key,
    sha256,
    bytes: bytes.length,
    ...fileIdentity(stat),
    parentDevice: parentIdentity.device,
    parentInode: parentIdentity.inode,
  });
  async function existing() {
    const previous = context.previous;
    if (
      !previous ||
      previous.path !== target ||
      previous.identityKey !== key ||
      previous.sha256 !== sha256 ||
      previous.bytes !== bytes.length ||
      previous.parentDevice !== parentIdentity.device ||
      previous.parentInode !== parentIdentity.inode
    )
      throw new ExecError("file_conflict");
    const file = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat({ bigint: true });
      if (
        !stat.isFile() ||
        stat.nlink !== 1n ||
        stat.size !== BigInt(bytes.length) ||
        !matchesFileIdentity(stat, previous)
      )
        throw new ExecError("file_conflict");
      const loaded = Buffer.alloc(bytes.length);
      let offset = 0;
      while (offset < loaded.length) {
        signal.throwIfAborted();
        const { bytesRead } = await file.read(
          loaded,
          offset,
          Math.min(64 * 1024, loaded.length - offset),
          offset,
        );
        if (!bytesRead) throw new ExecError("file_conflict");
        offset += bytesRead;
      }
      if (!loaded.equals(bytes)) throw new ExecError("file_conflict");
      await context.revalidate(signal);
      await check();
      const current = await lstat(target, { bigint: true });
      if (!sameFile(current, stat) || current.size !== stat.size || current.nlink !== 1n)
        throw new ExecError("file_conflict");
      return { status: "already_saved" as const, receipt: receipt(stat) };
    } finally {
      await file.close();
    }
  }
  try {
    await lstat(target);
    return await existing();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  // A prior delivery removed or moved by the user must not silently recreate their file.
  if (context.previous) throw new ExecError("file_conflict");
  const temp = join(cwd, `.pibot-${randomUUID()}.tmp`);
  if ((await writablePath(temp, cwd, context.writeRoots, context.denyWriteRoots)) !== temp)
    throw new ExecError("outside_workplace");
  const file = await open(
    temp,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  const owned = await file.stat({ bigint: true }).catch(async () => {
    await file.close();
    throw new ExecError("file_failed");
  });
  let published = false;
  async function cleanup() {
    let cleared = true;
    // A renamed directory can make our pathname unreachable; the held fd can still erase staging bytes.
    if (!published) {
      try {
        if ((await file.stat()).nlink === 1) {
          await file.truncate(0);
          await file.sync();
        }
      } catch {
        cleared = false;
      }
    }
    const closed = await file.close().then(
      () => true,
      () => false,
    );
    let removed = true;
    // Never remove a new object at the old pathname after a directory or temporary-file replacement.
    try {
      const current = await lstat(temp, { bigint: true });
      if (sameFile(current, owned)) await unlink(temp);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) removed = false;
    }
    if (!cleared || !closed || !removed) {
      if (published) throw new BinaryWriteError("file_failed", receipt(owned), "cleanup_failed");
      throw new ExecError("file_failed", "cleanup_failed");
    }
  }
  try {
    await check();
    const initial = await lstat(temp, { bigint: true });
    if (!sameFile(initial, owned) || initial.nlink !== 1n || (await realpath(temp)) !== temp)
      throw new ExecError("outside_workplace");
    await file.writeFile(bytes, { signal });
    await file.sync();
    await check();
    const staged = await lstat(temp, { bigint: true });
    if (!sameFile(staged, owned) || staged.nlink !== 1n || (await realpath(temp)) !== temp)
      throw new ExecError("outside_workplace");
    await context.revalidate(signal);
    await check();
    const ready = await lstat(temp, { bigint: true });
    if (
      !sameFile(ready, owned) ||
      ready.nlink !== 1n ||
      ready.size !== BigInt(bytes.length) ||
      (await realpath(temp)) !== temp
    )
      throw new ExecError("outside_workplace");
    await check();
    signal.throwIfAborted();
    try {
      await link(temp, target);
      published = true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST")
        throw new ExecError("file_conflict");
      throw error;
    }
    // The staging hard link is ours; remove it before writablePath's hard-link alias guard.
    const linked = await lstat(temp, { bigint: true });
    if (!sameFile(linked, owned)) throw new ExecError("file_conflict");
    await unlink(temp);
    // Drain a completed publication even if cancellation arrived during link; report its real side effect.
    await check(new AbortController().signal);
    const delivered = await lstat(target, { bigint: true });
    if (!sameFile(delivered, owned)) throw new ExecError("file_conflict");
    return { status: "written" as const, receipt: receipt(delivered) };
  } catch (error) {
    if (published)
      throw new BinaryWriteError(
        error instanceof ExecError ? error.code : "file_failed",
        receipt(owned),
        error instanceof ExecError ? error.reason : undefined,
      );
    throw error;
  } finally {
    await cleanup();
  }
}
