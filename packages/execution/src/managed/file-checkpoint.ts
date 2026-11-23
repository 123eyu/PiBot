import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { z } from "zod";
import { ExecError, type ExecOptions } from "../core/types.ts";
import { childNodeRuntime } from "../runtime/child-node.ts";
import { runNativeCheckpoint } from "./checkpoint-native.ts";
import { CHECKPOINT_RECIPE_SOURCE } from "./checkpoint-recipe-source.ts";
import { type ManagedPathIdentity, managedIdentity, managedQuote } from "./managed-boundary.ts";
import { ManagedExecError } from "./managed-errors.ts";
import { type ManagedRecipe, runManagedRecipe } from "./managed-recipe.ts";

export interface CheckpointBytes {
  hash: string;
  bytes: number;
  mode: number;
  alternatives?: { hash: string; mode: number }[];
}
const unsafe = new Set([
  ".git",
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".pi",
  ".pibot",
  ".pibot-file-recovery",
  ".env",
  ".netrc",
  ".npmrc",
  ".gitconfig",
  ".git-credentials",
  ".zshrc",
  ".bashrc",
]);
/** No symlink, hardlink, metadata or secret-named path is a file-restoration target. */
export async function checkpointParents(
  root: ManagedPathIdentity,
  path: string,
  signal: AbortSignal,
) {
  const parts = relative(root.path, path).split(sep);
  if (
    !parts.length ||
    parts.some(
      (part, index) =>
        !part ||
        part === ".." ||
        // Deliverables under `.pibot/out` are user files; the rest of `.pibot` is Pi Bot's. The
        // exception folds case like the unsafe names do: Windows and macOS spell `.PiBot/Out` too.
        (unsafe.has(part.toLowerCase()) &&
          !(
            part.toLowerCase() === ".pibot" &&
            parts[index + 1]?.toLowerCase() === "out" &&
            index + 2 < parts.length
          )) ||
        /^\.env(?:\.|$)/i.test(part),
    ) ||
    /[\0\r\n]/.test(path)
  )
    throw new ExecError("outside_workplace");
  const parents = [root];
  let current = root.path;
  for (const part of parts.slice(0, -1)) {
    signal.throwIfAborted();
    current = join(current, part);
    parents.push(await managedIdentity(current));
  }
  return parents;
}
export interface CheckpointRestoreInput
  extends Omit<ManagedRecipe, "command" | "label" | "identities" | "writePaths"> {
  root: ManagedPathIdentity;
  target: string;
  recovery: string;
  journal: string;
  before: CheckpointBytes | null;
  after: CheckpointBytes | null;
  blob: string | null;
  reconcile?: boolean;
  resume?: boolean;
}
/** Create only fresh journal directories inside SRT, never native mkdir through an unpinned parent. */
export async function prepareCheckpointRecovery(
  options: ExecOptions,
  input: {
    root: ManagedPathIdentity;
    checkpointId: string;
    restoreId: string;
    itemIds: string[];
  } & Pick<ManagedRecipe, "home" | "dataDir" | "signal" | "assertAuthorized">,
) {
  if (
    !/^[0-9a-f-]{36}$/.test(input.checkpointId) ||
    !/^[0-9a-f-]{36}$/.test(input.restoreId) ||
    !input.itemIds.length ||
    input.itemIds.length > 500 ||
    input.itemIds.some((id) => !/^[0-9a-f-]{36}$/.test(id))
  )
    throw new ExecError("invalid_input");
  const parent = join(
    input.dataDir,
    "bots",
    basename(dirname(input.home)),
    "file-checkpoints",
    input.checkpointId,
    "restores",
    input.restoreId,
  );
  const privateParent = await managedIdentity(parent);
  if (privateParent.device !== input.root.device)
    throw new ManagedExecError("checkpoint_cross_device");
  const base = join(parent, "files"),
    operation = base;
  // The child re-checks identities recorded by managedIdentity, so it repeats the canonical
  // bigint encoding of core/file-identity.ts (decimal up to 2^53 - 1, otherwise 0x-hex).
  if (options.platform === "linux" || options.platform === "win32") {
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]);
    const check = async () => {
      signal.throwIfAborted();
      input.assertAuthorized();
      for (const pinned of [input.root, privateParent]) {
        const actual = await managedIdentity(pinned.path);
        if (actual.device !== pinned.device || actual.inode !== pinned.inode)
          throw new ExecError("outside_workplace");
      }
    };
    await check();
    await mkdir(base, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const directory = await managedIdentity(base);
    if (directory.device !== input.root.device)
      throw new ManagedExecError("checkpoint_cross_device");
    const probe = join(base, `.link-probe-${randomUUID()}`),
      linked = `${probe}.link`;
    const handle = await open(probe, "wx", 0o600);
    try {
      await check();
      try {
        await link(probe, linked);
      } catch {
        throw new ManagedExecError("checkpoint_hardlink_unsupported");
      }
    } finally {
      await handle.close();
      for (const path of [linked, probe])
        await unlink(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
    }
    await check();
    for (const id of input.itemIds) {
      await check();
      const current = await managedIdentity(base);
      if (current.device !== directory.device || current.inode !== directory.inode)
        throw new ExecError("outside_workplace");
      await mkdir(join(base, id), { mode: 0o700 });
    }
    await check();
    return operation;
  }
  const source =
    "await (async()=>{const fs=await import('node:fs/promises');const p=await import('node:path');const v=JSON.parse(Buffer.from(process.argv[1],'base64url'));const enc=x=>x<=BigInt(Number.MAX_SAFE_INTEGER)?x.toString():'0x'+x.toString(16);const root=await fs.lstat(v.root.path,{bigint:true});if(!root.isDirectory()||root.isSymbolicLink()||enc(root.dev)!==v.root.device||enc(root.ino)!==v.root.inode||await fs.realpath(v.root.path)!==v.root.path)throw Error('boundary');const parent=await fs.lstat(v.privateParent.path,{bigint:true});if(!parent.isDirectory()||parent.isSymbolicLink()||enc(parent.dev)!==v.privateParent.device||enc(parent.ino)!==v.privateParent.inode||await fs.realpath(v.privateParent.path)!==v.privateParent.path)throw Error('boundary');try{await fs.mkdir(v.base,{mode:448})}catch(e){if(e.code!=='EEXIST')throw e}const b=await fs.lstat(v.base,{bigint:true});if(!b.isDirectory()||b.isSymbolicLink()||await fs.realpath(v.base)!==v.base||b.dev!==root.dev)throw Error('boundary');const probe=p.join(v.base,'.link-probe-'+v.probe),linked=probe+'.link';const handle=await fs.open(probe,'wx',384);try{try{await fs.link(probe,linked)}catch{process.stdout.write('checkpoint_hardlink_unsupported\\n');return}}finally{await handle.close();for(const file of [linked,probe])try{await fs.unlink(file)}catch(e){if(e.code!=='ENOENT')throw e}}for(const id of v.items)await fs.mkdir(p.join(v.operation,id),{mode:448});})();";
  const payload = Buffer.from(
    JSON.stringify({
      root: input.root,
      privateParent,
      base,
      operation,
      items: input.itemIds,
      probe: randomUUID(),
    }),
  ).toString("base64url");
  const prepared = await runManagedRecipe(options, {
    ...input,
    cwd: input.root.path,
    identities: [input.root, privateParent],
    writePaths: [],
    privateRecovery: base,
    readPaths: [parent],
    command: [
      "/usr/bin/env",
      childNodeRuntime().executable,
      "--input-type=module",
      "-e",
      source,
      payload,
    ]
      .map(managedQuote)
      .join(" "),
    label: "checkpoint_restore",
  });
  if (prepared.truncatedOutput.trim() === "checkpoint_hardlink_unsupported")
    throw new ManagedExecError("checkpoint_hardlink_unsupported");
  return operation;
}
/** Only this fixed recipe may temporarily move an inode and publish a checked snapshot. */
export async function restoreCheckpointFile(options: ExecOptions, input: CheckpointRestoreInput) {
  const parents = await checkpointParents(input.root, input.target, input.signal);
  const recovery = await managedIdentity(input.recovery);
  const privateRoot = join(
    input.dataDir,
    "bots",
    basename(dirname(input.home)),
    "file-checkpoints",
  );
  const journalParts = relative(privateRoot, input.journal).split(sep),
    uuid = /^[0-9a-f-]{36}$/;
  if (
    journalParts.length !== 4 ||
    !uuid.test(journalParts[0] ?? "") ||
    journalParts[1] !== "restores" ||
    !uuid.test(journalParts[2] ?? "") ||
    !uuid.test((journalParts[3] ?? "").replace(/\.jsonl$/, "")) ||
    !input.journal.endsWith(".jsonl")
  )
    throw new ExecError("outside_workplace");
  const journalParent = await managedIdentity(dirname(input.journal));
  const journal = await lstat(input.journal);
  if (
    !journal.isFile() ||
    journal.isSymbolicLink() ||
    journal.nlink !== 1 ||
    journal.size > 32 * 1024 ||
    (await realpath(input.journal)) !== input.journal
  )
    throw new ExecError("file_conflict");
  const itemId = (journalParts[3] as string).replace(/\.jsonl$/, "");
  const privateRecovery = join(journalParent.path, "files", itemId);
  const legacyRecovery = join(
    input.root.path,
    ".pibot-file-recovery",
    journalParts[2] as string,
    itemId,
  );
  if (input.recovery !== privateRecovery && input.recovery !== legacyRecovery)
    throw new ExecError("outside_workplace");
  if (recovery.device !== input.root.device) throw new ManagedExecError("checkpoint_cross_device");
  const privateFiles =
    input.recovery === privateRecovery
      ? await managedIdentity(dirname(privateRecovery))
      : undefined;
  const operationInput = {
    platform: options.platform,
    root: input.root,
    parents: [...parents, recovery, journalParent, ...(privateFiles ? [privateFiles] : [])],
    target: input.target,
    recovery: input.recovery,
    journal: input.journal,
    before: input.before,
    after: input.after,
    blob: input.blob,
    reconcile: input.reconcile ?? false,
    resume: input.resume ?? false,
  };
  const payload = Buffer.from(JSON.stringify(operationInput)).toString("base64url");
  // The separately signed helper Node runs this fixed command; no user environment is imported.
  const program = childNodeRuntime().executable;
  const command = [
    "/usr/bin/env",
    program,
    "--input-type=module",
    "-e",
    CHECKPOINT_RECIPE_SOURCE,
    payload,
  ]
    .map(managedQuote)
    .join(" ");
  const native = options.platform === "linux" || options.platform === "win32";
  const result = native
    ? undefined
    : await runManagedRecipe(options, {
        ...input,
        identities: [...parents, recovery, journalParent, ...(privateFiles ? [privateFiles] : [])],
        writePaths: input.reconcile
          ? []
          : [dirname(input.target), ...(privateFiles ? [] : [input.recovery])],
        ...(!input.reconcile && privateFiles ? { privateRecovery: input.recovery } : {}),
        readPaths: [
          ...(input.blob ? [input.blob] : []),
          input.journal,
          ...(privateFiles ? [input.recovery] : []),
        ],
        ...(!input.reconcile ? { privateJournal: input.journal } : {}),
        command,
        label: "checkpoint_restore",
      });
  const nativeResult = native
    ? await runNativeCheckpoint(
        operationInput,
        [...parents, recovery, journalParent, ...(privateFiles ? [privateFiles] : [])],
        input.signal,
        input.assertAuthorized,
      )
    : undefined;
  try {
    const last = native
      ? nativeResult
      : JSON.parse(result?.truncatedOutput.trim().split("\n").at(-1) ?? "");
    return z
      .strictObject({
        state: z.enum(["restored", "conflict", "interrupted"]),
        retained: z.boolean().optional(),
        reason: z
          .enum(["file_changed", "unsafe_path", "recovery_interrupted", "file_in_use"])
          .optional(),
      })
      .parse(last);
  } catch {
    throw new ExecError("command_failed");
  }
}

export { hashCheckpointFile, readCheckpointFile } from "./checkpoint-image.ts";
