import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { checkpointParents, ExecError } from "@pibot/execution";
import {
  type CheckpointImage,
  type CheckpointRecord,
  FileCheckpointsRepo,
  RunFileChangesRepo,
  transaction,
} from "@pibot/storage";
import type { CheckpointCapture, CheckpointCaptureReason } from "@pibot/workspaces-contract/full";
import type { ChangesScope } from "../changes/changes-scope.ts";
import { isManagedCleanupFailure } from "./managed-failure.ts";
import type { ManagedResourcePorts } from "./managed-resource-ports.ts";

const BYTES = 32 * 1024 * 1024;
export class CaptureSkip extends Error {
  constructor(readonly reason: CheckpointCaptureReason) {
    super(reason);
  }
}

export function captureSkipReason(error: unknown, signal: AbortSignal) {
  if (isManagedCleanupFailure(error)) return undefined;
  if (error instanceof CaptureSkip) return error.reason;
  if (error instanceof Error && error.message === "office_checkpoint_unavailable")
    return "checkpoint_bytes_quota" as const;
  if (
    (signal.aborted && error === signal.reason) ||
    (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name))
  )
    return "capture_interrupted" as const;
  return undefined;
}

const snapshotUnavailable = (error: unknown) =>
  (error instanceof ExecError && ["file_conflict", "outside_workplace"].includes(error.code)) ||
  (error instanceof Error &&
    "code" in error &&
    ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(String(error.code)));

/** Called under the original run's still-held write lease, after its tools and SDK drained. */
export async function captureCheckpoint(
  ...args: Parameters<typeof captureInternal>
): Promise<CheckpointCapture> {
  const [db, ports, scope, runId, , signal] = args;
  const office =
    new FileCheckpointsRepo(db)
      .forRun(runId, scope.root.path)
      ?.items.some((item) => /\.(docx|xlsx|pptx)$/i.test(item.path)) ||
    new RunFileChangesRepo(db)
      .summarize(runId)
      .some((row) => row.root === scope.root.path && /\.(docx|xlsx|pptx)$/i.test(row.path));
  try {
    return await (office && ports.snapshot
      ? ports.snapshot(() => captureInternal(...args), signal)
      : captureInternal(...args));
  } catch (error) {
    const previous = new FileCheckpointsRepo(db).forRun(runId, scope.root.path);
    if (!previous || previous.state === "expired" || !captureSkipReason(error, signal)) throw error;
    const receipt: CheckpointCapture = {
      state: "retained",
      checkpointId: previous.id,
      reason: null,
    };
    if (args[6] !== false) new FileCheckpointsRepo(db).saveCapture(runId, receipt);
    return receipt;
  }
}
async function captureInternal(
  db: DatabaseSync,
  ports: ManagedResourcePorts,
  scope: ChangesScope,
  runId: string,
  assertAuthorized: () => void,
  signal: AbortSignal,
  saveReceipt = true,
): Promise<CheckpointCapture> {
  const repo = new FileCheckpointsRepo(db),
    existing = saveReceipt ? repo.capture(runId) : undefined;
  if (existing) return existing;
  const identity = {
    path: scope.root.path,
    device: scope.root.device as string,
    inode: scope.root.inode as string,
  };
  const previous = repo.forRun(runId, identity.path);
  const rows = new RunFileChangesRepo(db)
    .summarize(runId)
    .filter((row) => row.root === identity.path && row.kind !== "command");
  const id = previous?.id ?? randomUUID(),
    directory = join(ports.dataDir, "bots", scope.botId, "file-checkpoints", id);
  const written = new Set<string>();
  const office =
    previous?.items.some((item) => /\.(docx|xlsx|pptx)$/i.test(item.path)) ||
    rows.some((row) => /\.(docx|xlsx|pptx)$/i.test(row.path));
  let created = false,
    committed = false;
  try {
    signal.throwIfAborted();
    assertAuthorized();
    if (!rows.length) throw new CaptureSkip("snapshot_unavailable");
    if (
      repo.projectItems(identity) +
        rows.filter((row) => !previous?.items.some((item) => item.path === row.path)).length >
      500
    )
      throw new CaptureSkip("project_items_quota");
    const blobs = new Map<string, Buffer>();
    const officeBlobs = new Set<string>();
    let bytes = 0;
    const value: CheckpointRecord = {
      id,
      botId: scope.botId,
      runId,
      scopeKey: `${scope.conversationKey}|${scope.topicId ?? ""}`,
      root: identity.path,
      identity,
      state: "available",
      version: 1,
      createdAt: new Date().toISOString(),
      truncated: false,
      items: [...(previous?.items ?? [])],
      images: new Map(previous?.images),
    };
    for (const row of rows) {
      signal.throwIfAborted();
      assertAuthorized();
      const item: CheckpointRecord["items"][number] = {
        id: previous?.items.find((item) => item.path === row.path)?.id ?? randomUUID(),
        path: row.path,
        kind: row.kind,
        restorable: false,
        reason: null,
      };
      let before: CheckpointImage | null = null,
        after: CheckpointImage | null = null;
      if (
        row.rootDevice !== identity.device ||
        row.rootInode !== identity.inode ||
        !row.afterRef ||
        row.afterMode === null ||
        (row.kind !== "add" && (!row.beforeRef || row.beforeMode === null))
      )
        item.reason = "snapshot_missing";
      else {
        try {
          await checkpointParents(identity, row.path, signal);
          const image = async (ref: string, mode: number): Promise<CheckpointImage> => {
            const captured = await ports.target.readCheckpoint(
              join(ports.dataDir, "bots", scope.botId, "changes", runId, ref),
              signal,
              /\.(docx|xlsx|pptx)$/i.test(row.path) ? 100 * 1024 * 1024 : undefined,
            );
            if (captured.image.hash !== ref) throw new ExecError("file_conflict");
            bytes += captured.bytes.length;
            if (
              bytes >
              (rows.some((row) => /\.(docx|xlsx|pptx)$/i.test(row.path))
                ? 512 * 1024 * 1024
                : BYTES)
            )
              throw new CaptureSkip("checkpoint_bytes_quota");
            blobs.set(ref, captured.bytes);
            if (/\.(docx|xlsx|pptx)$/i.test(row.path)) officeBlobs.add(ref);
            return { hash: ref, blob: ref, bytes: captured.bytes.length, mode };
          };
          if (row.beforeRef && row.beforeMode !== null)
            before = await image(row.beforeRef, row.beforeMode);
          after = await image(row.afterRef, row.afterMode);
          const prepared = previous?.images.get(item.id)?.after;
          if (prepared?.alternatives) after.alternatives = prepared.alternatives;
          assertAuthorized();
          item.restorable = true;
        } catch (error) {
          if (isManagedCleanupFailure(error) || !snapshotUnavailable(error)) throw error;
          assertAuthorized();
          item.reason = "snapshot_missing";
          before = after = null;
        }
      }
      // A failed post-write read must not erase an already durable pre-publication recovery item.
      if (
        !item.restorable &&
        previous?.items.find((old) => old.id === item.id)?.restorable &&
        previous.images.get(item.id)?.after
      )
        continue;
      value.items = value.items.filter((existing) => existing.path !== item.path);
      value.items.push(item);
      value.images.set(item.id, { before, after });
    }
    value.state = value.items.some((item) => !item.restorable) ? "partial" : "available";
    assertAuthorized();
    const existingBlobs = new Set(
      await readdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      }),
    );
    if (office)
      await ports.snapshotBudget?.admit(
        [...blobs].reduce(
          (sum, [hash, blob]) => sum + (existingBlobs.has(hash) ? 0 : blob.length),
          0,
        ),
        signal,
      );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    created = true;
    for (const [hash, blob] of blobs) {
      signal.throwIfAborted();
      assertAuthorized();
      const handle = await open(join(directory, hash), "wx", 0o600).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "EEXIST") return undefined;
          throw error;
        },
      );
      if (!handle) continue;
      written.add(hash);
      try {
        await handle.writeFile(blob, { signal });
        if (officeBlobs.has(hash)) await handle.sync();
        ports.snapshotBudget?.added(blob.length);
      } finally {
        await handle.close();
      }
    }
    assertAuthorized();
    const receipt: CheckpointCapture = { state: "retained", checkpointId: id, reason: null };
    transaction(db, () => {
      if (
        repo.projectItems(identity) +
          value.items.filter((item) => !previous?.items.some((old) => old.path === item.path))
            .length >
        500
      )
        throw new CaptureSkip("project_items_quota");
      if (
        office &&
        repo.reservedBytes() - repo.imageBytes(previous) + repo.imageBytes(value) >
          2 * 1024 * 1024 * 1024
      )
        throw new CaptureSkip("checkpoint_bytes_quota");
      repo.merge(value);
      if (saveReceipt) repo.saveCapture(runId, receipt);
    });
    committed = true;
    return receipt;
  } catch (error) {
    if (committed) throw error;
    const reason = captureSkipReason(error, signal);
    if (!reason) throw error;
    const receipt: CheckpointCapture =
      previous && previous.state !== "expired"
        ? { state: "retained", checkpointId: previous.id, reason: null }
        : { state: "skipped", checkpointId: null, reason };
    if (saveReceipt) repo.saveCapture(runId, receipt);
    return receipt;
  } finally {
    // This fresh UUID directory contains only this attempt's unpublished blobs, never recovery inodes.
    if (created && !committed) {
      if (!previous) await rm(directory, { recursive: true, force: true });
      else for (const hash of written) await rm(join(directory, hash), { force: true });
      ports.snapshotBudget?.invalidate();
    }
  }
}
