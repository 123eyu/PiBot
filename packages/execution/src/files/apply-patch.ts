import { randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sameFile } from "../core/file-identity.ts";
import { missing, writablePath } from "../core/paths.ts";
import { ExecError, type FileContext } from "../core/types.ts";
import { verifyWorkspace } from "../sandbox/workspace.ts";
import { createParents } from "./files.ts";
import { type PatchFile, parsePatch } from "./patch-format.ts";
import { patchJournal } from "./patch-journal.ts";
import { PatchRecoveryError, publishPatch, type StagedFile } from "./patch-publish.ts";
import { applyEdits } from "./replace-text.ts";
import { boundDiff, textDiff } from "./text-diff.ts";
import { MAX_WRITE_BYTES, type TextSnapshot, textSnapshot } from "./text-snapshot.ts";

export interface PatchOptions extends FileContext {
  patch: string;
  journalDir: string;
  expectedPaths: readonly string[];
  assertCurrent(): void;
}

async function content(file: PatchFile, before: string | null, signal: AbortSignal) {
  if (file.kind === "add") {
    if (before !== null) throw new ExecError("file_conflict");
    return file.content;
  }
  if (before === null) throw new ExecError("file_not_found");
  return file.kind === "delete"
    ? null
    : (await applyEdits(before, file.edits, signal)).toString("utf8");
}

async function temporary(path: string, context: FileContext, content?: string, mode = 0o600) {
  const temp = join(dirname(path), `.pibot-${randomUUID()}.tmp`);
  if ((await writablePath(temp, context.cwd, context.writeRoots, context.denyWriteRoots)) !== temp)
    throw new ExecError("outside_workplace");
  const file = await open(
    temp,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (content !== undefined) await file.writeFile(content, { signal: context.signal });
    await file.chmod(mode);
    await file.sync();
    return { path: temp, stat: await file.stat({ bigint: true }) };
  } catch (error) {
    await file.close();
    await unlink(temp);
    throw error;
  } finally {
    // FileHandle.close is idempotent, including the Windows cleanup path above.
    await file.close();
  }
}

/** Discover unsupported filesystems before moving any original file. */
async function publicationSupported(
  file: { path: string; stat: BigIntStats },
  context: FileContext,
) {
  const probe = join(dirname(file.path), `.pibot-${randomUUID()}.tmp`);
  await writablePath(probe, context.cwd, context.writeRoots, context.denyWriteRoots);
  try {
    await link(file.path, probe);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM"].includes(code ?? ""))
      throw new ExecError("file_failed", "unsupported_platform");
    throw error;
  }
  try {
    context.signal.throwIfAborted();
  } finally {
    await unlink(probe);
    file.stat = await lstat(file.path, { bigint: true });
  }
}

export async function applyPatch(options: PatchOptions) {
  const context = {
    ...options,
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]),
  };
  if (!context.rootIdentities?.length) throw new ExecError("outside_workplace");
  const patch = parsePatch(options.patch);
  if (patch.length !== options.expectedPaths.length) throw new ExecError("invalid_input");
  await verifyWorkspace(context.rootIdentities, context.signal);
  const paths = await Promise.all(
    patch.map((file) =>
      writablePath(file.path, context.cwd, context.writeRoots, context.denyWriteRoots),
    ),
  );
  // Canonical aliases and ancestor/descendant targets are ambiguous transactions.
  const keys = paths.map((path) => (process.platform === "win32" ? path.toLowerCase() : path));
  if (
    new Set(keys).size !== paths.length ||
    paths.some((path, i) => path !== options.expectedPaths[i])
  )
    throw new ExecError("invalid_input");
  const targets = new Set(keys);
  for (const target of keys) {
    let parent = dirname(target);
    while (parent !== dirname(parent)) {
      if (targets.has(parent)) throw new ExecError("invalid_input");
      parent = dirname(parent);
    }
  }
  const prepared: { path: string; before: TextSnapshot | null; next: string | null }[] = [];
  let bytes = 0;
  let diff = "";
  for (const [i, file] of patch.entries()) {
    const path = paths[i] as string;
    const before = await textSnapshot(path, context.signal);
    const next = await content(file, before?.text ?? null, context.signal);
    if (before && prepared.some((file) => !!file.before && sameFile(file.before.stat, before.stat)))
      throw new ExecError("invalid_input");
    bytes += Buffer.byteLength(before?.text ?? "") + Buffer.byteLength(next ?? "");
    if (bytes > MAX_WRITE_BYTES) throw new ExecError("invalid_input");
    if (diff.length <= 4000)
      diff = boundDiff(
        diff + (await textDiff(file.path, before?.text ?? null, next, context.signal)),
      );
    prepared.push({ path, before, next });
  }
  const staged: StagedFile[] = [];
  let retain = false;
  let journal: Awaited<ReturnType<typeof patchJournal>> | undefined;
  try {
    for (const file of prepared) {
      options.assertCurrent();
      await createParents(dirname(file.path), context);
      if ((await realpath(dirname(file.path))) !== dirname(file.path))
        throw new ExecError("outside_workplace");
      const entry: StagedFile = {
        ...file,
        parent: await lstat(dirname(file.path), { bigint: true }),
        backup: await temporary(file.path, context),
      };
      staged.push(entry);
      if (file.next !== null)
        entry.stage = await temporary(
          file.path,
          context,
          file.next,
          file.before ? Number(file.before.stat.mode & 0o777n) : 0o600,
        );
    }
    for (const file of staged) await publicationSupported(file.stage ?? file.backup, context);
    await verifyWorkspace(context.rootIdentities, context.signal);
    for (const file of staged)
      if (
        (await writablePath(file.path, context.cwd, context.writeRoots, context.denyWriteRoots)) !==
        file.path
      )
        throw new ExecError("outside_workplace");
    journal = await patchJournal(
      options.journalDir,
      staged,
      context,
      prepared.map((file) => file.next),
    );
    publishPatch(staged, context, options.assertCurrent);
    try {
      journal.commit();
    } catch {
      throw new PatchRecoveryError();
    }
    return {
      files: prepared.map((file) => ({
        path: file.path,
        bytes: Buffer.byteLength(file.next ?? ""),
        deleted: file.next === null,
      })),
      diff,
    };
  } catch (error) {
    retain = error instanceof PatchRecoveryError;
    throw error;
  } finally {
    await journal?.close();
    if (!retain && journal) await journal.clear();
    if (!retain && !journal) {
      for (const file of staged)
        for (const temp of [file.stage, file.backup])
          if (temp)
            await unlink(temp.path).catch((error: unknown) => {
              if (!missing(error)) throw error;
            });
    }
  }
}
