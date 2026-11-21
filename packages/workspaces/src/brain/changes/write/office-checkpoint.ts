import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { BeforeWrite, RunChangesPort, ToolRunContext } from "@pibot/brain/kit";
import { checkpointParents, type ExecutionTarget, managedIdentity } from "@pibot/execution";
import {
  type CheckpointRecord,
  FileCheckpointsRepo,
  RunFileChangesRepo,
  transaction,
} from "@pibot/storage";

const LIMIT = 100 * 1024 * 1024;
const BUDGET = 2 * 1024 * 1024 * 1024;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Directory durability is available on Unix; Windows flushes each blob before the DB commit. */
async function syncDirectory(path: string, platform: string) {
  if (platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function prepareOfficeCheckpoint(input: {
  db: DatabaseSync;
  dataDir: string;
  platform: string;
  target: ExecutionTarget;
  context: ToolRunContext;
  before: BeforeWrite;
  path: string;
  root: string;
  candidate: Uint8Array;
  scopeKey?: string;
  budget?: RunChangesPort["snapshotBudget"];
  assertCurrent(): void;
}) {
  const { db, context, before, path, root, assertCurrent, target } = input;
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]);
  const check = () => {
    signal.throwIfAborted();
    assertCurrent();
  };
  check();
  if (
    !/\.(docx|xlsx|pptx)$/i.test(path) ||
    !before.beforeRef ||
    before.beforeMode == null ||
    input.candidate.byteLength > LIMIT
  )
    throw new Error("office_checkpoint_unavailable");
  const pinned = context.runWorkplace?.boundary.roots.find((r) => r.canonicalPath === root);
  if (!pinned?.device || !pinned.inode || pinned.role === "readonly")
    throw new Error("office_checkpoint_unavailable");
  const identity = await managedIdentity(root);
  if (identity.device !== pinned.device || identity.inode !== pinned.inode)
    throw new Error("office_checkpoint_unavailable");
  await checkpointParents(identity, path, signal);
  const image = async (path: string) =>
    target.hashCheckpoint
      ? target.hashCheckpoint(path, signal, LIMIT)
      : (await target.readCheckpoint(path, signal, LIMIT)).image;
  const sourcePath = join(
    input.dataDir,
    "bots",
    context.botId,
    "changes",
    context.runId,
    before.beforeRef,
  );
  const source = { image: await image(sourcePath) };
  if (source.image.hash !== before.beforeRef) throw new Error("office_checkpoint_unavailable");
  const candidate = input.candidate,
    afterHash = digest(candidate);
  const repo = new FileCheckpointsRepo(db),
    previous = repo.forRun(context.runId, root);
  const previousItem = previous?.items.find((item) => item.path === path);
  const previousImage = previousItem && previous?.images.get(previousItem.id);
  const first = new RunFileChangesRepo(db)
    .summarize(context.runId)
    .find((row) => row.root === root && row.path === path && row.kind !== "command");
  if (
    first &&
    (first.rootDevice !== identity.device ||
      first.rootInode !== identity.inode ||
      (first.kind !== "add" && (!first.beforeRef || first.beforeMode == null)))
  )
    throw new Error("office_checkpoint_unavailable");
  const addition = previousItem?.kind === "add" || first?.kind === "add";
  const earliest =
    !previousImage?.before && !addition && first?.beforeRef && first.beforeRef !== before.beforeRef
      ? {
          image: await image(
            join(input.dataDir, "bots", context.botId, "changes", context.runId, first.beforeRef),
          ),
        }
      : source;
  if (first?.beforeRef && earliest !== source && earliest.image.hash !== first.beforeRef)
    throw new Error("office_checkpoint_unavailable");
  const alternatives = [...(previousImage?.after?.alternatives ?? [])];
  if (!alternatives.some((v) => v.hash === source.image.hash))
    alternatives.push({
      hash: source.image.hash,
      mode: before.beforeMode,
      bytes: source.image.bytes,
    });
  if (
    previousImage?.after &&
    previousImage.after.hash !== afterHash &&
    !alternatives.some((v) => v.hash === previousImage.after?.hash)
  )
    alternatives.push({
      hash: previousImage.after.hash,
      mode: previousImage.after.mode,
      bytes: previousImage.after.bytes,
    });
  if (alternatives.length > 100) throw new Error("office_checkpoint_unavailable");
  const id = previous?.id ?? randomUUID(),
    itemId = previousItem?.id ?? randomUUID();
  const directory = join(input.dataDir, "bots", context.botId, "file-checkpoints", id);
  const beforeImage = addition
    ? null
    : (previousImage?.before ?? {
        ...earliest.image,
        mode: first?.beforeMode ?? before.beforeMode,
        blob: earliest.image.hash,
      });
  const afterImage = {
    hash: afterHash,
    blob: afterHash,
    bytes: candidate.byteLength,
    mode: before.beforeMode,
    alternatives,
  };
  const value: CheckpointRecord = {
    id,
    botId: context.botId,
    runId: context.runId,
    scopeKey:
      input.scopeKey ??
      `${context.groupId ? `group:${context.groupId}` : `dm:${context.botId}`}|${context.groupId ? "" : (context.conversationId ?? "")}`,
    root,
    identity,
    state: "available",
    version: 1,
    createdAt: new Date().toISOString(),
    truncated: false,
    items: [
      { id: itemId, path, kind: addition ? "add" : "modify", restorable: true, reason: null },
    ],
    images: new Map([[itemId, { before: beforeImage, after: afterImage }]]),
  };
  const proposed = { ...value, images: new Map(previous?.images) };
  proposed.images.set(itemId, { before: beforeImage, after: afterImage });
  const admit = () => {
    check();
    if (
      repo.projectItems(identity) + (previousItem ? 0 : 1) > 500 ||
      repo.reservedBytes() - repo.imageBytes(previous) + repo.imageBytes(proposed) > BUDGET
    )
      throw new Error("office_checkpoint_unavailable");
  };
  admit();
  await input.budget?.admit(previousImage?.before ? 0 : (beforeImage?.bytes ?? 0), signal);
  let ownedBlob: string | undefined;
  let committed = false;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Only the before-image is needed to restore. The unpublished candidate is bound by SHA-256,
    // not a second large blob; afterWrite can capture its bytes for the ordinary diff pipeline.
    if (beforeImage) {
      const blob = join(directory, beforeImage.blob);
      const handle = previousImage?.before
        ? undefined
        : await open(blob, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "EEXIST") return undefined;
            throw error;
          });
      if (handle) {
        ownedBlob = blob;
        try {
          const snapshot = await target.readCheckpoint(
            join(
              input.dataDir,
              "bots",
              context.botId,
              "changes",
              context.runId,
              earliest.image.hash,
            ),
            signal,
            LIMIT,
          );
          await handle.writeFile(snapshot.bytes, { signal });
          await handle.sync();
          input.budget?.added(beforeImage.bytes);
        } finally {
          await handle.close();
        }
      }
      const verified = await image(blob);
      if (verified.hash !== beforeImage.hash) throw new Error("office_checkpoint_unavailable");
    }
    await syncDirectory(directory, input.platform);
    await syncDirectory(join(directory, ".."), input.platform);
    check();
    const current = await image(path);
    if (current.hash !== source.image.hash) throw new Error("office_checkpoint_unavailable");
    transaction(db, () => {
      admit();
      repo.merge(value);
    });
    committed = true;
  } finally {
    if (!committed && ownedBlob) {
      await rm(ownedBlob, { force: true });
      input.budget?.invalidate();
    }
  }
  return id;
}

/** Failed candidates and superseded versions otherwise escape the metadata-based budget. */
export async function pruneOfficeBlobs(
  dataDir: string,
  db: DatabaseSync,
  active: Set<string>,
  cutoff: string,
  signal = AbortSignal.timeout(30_000),
) {
  signal.throwIfAborted();
  const repo = new FileCheckpointsRepo(db);
  for (const value of repo.expireBefore(cutoff, [...active])) {
    signal.throwIfAborted();
    await rm(join(dataDir, "bots", value.botId, "file-checkpoints", value.id), {
      recursive: true,
      force: true,
    });
  }
  const bots = await readdir(join(dataDir, "bots"), { withFileTypes: true }).catch(() => []);
  for (const bot of bots) {
    signal.throwIfAborted();
    if (!bot.isDirectory() || !/^[0-9a-f-]{36}$/.test(bot.name)) continue;
    const base = join(dataDir, "bots", bot.name, "file-checkpoints");
    for (const dir of (await readdir(base, { withFileTypes: true }).catch(() => [])).slice(
      0,
      2000,
    )) {
      signal.throwIfAborted();
      if (!dir.isDirectory() || !/^[0-9a-f-]{36}$/.test(dir.name)) continue;
      const value = repo.get(dir.name);
      if (value && (active.has(value.runId) || value.state !== "expired")) continue;
      const info = await stat(join(base, dir.name));
      if (info.mtimeMs < Date.parse(cutoff))
        await rm(join(base, dir.name), { recursive: true, force: true });
    }
  }
}
