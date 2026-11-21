import { constants } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { ExecError } from "@pibot/execution";
import {
  captureProject,
  type SourceAccess,
  semanticHash,
  snapshotHash,
} from "@pibot/execution/semantic";
import { IdSchema, RpcError } from "@pibot/protocol-base";
import { z } from "zod";
import type { LocalService } from "../../local-service.ts";
import type { ChangesScope } from "../workspaces/types.ts";

const safePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (v) =>
      !v.startsWith("/") &&
      !v.includes("\\") &&
      !v.split("/").includes("..") &&
      !/[\0\r\n]/.test(v),
  );
const digest = z.string().regex(/^[0-9a-f]{64}$/);
export const ReviewSnapshotSchema = z.strictObject({
  version: z.literal(1),
  scope: z.enum(["turn", "uncommitted"]),
  targets: z.array(safePath).max(200).optional(),
  root: z.string().max(32768),
  files: z
    .array(z.strictObject({ path: safePath, text: z.string().max(1024 * 1024), hash: digest }))
    .max(512),
  identity: z.strictObject({ device: z.string().max(100), inode: z.string().max(100) }),
  authorization: digest,
  hash: digest,
  reasons: z.array(z.string().max(100)).max(30),
  diff: z.string().max(1024 * 1024),
  gitHash: digest.nullable(),
  reviewHash: digest,
});
export type ReviewSnapshot = z.infer<typeof ReviewSnapshotSchema>;
function reviewHash(value: Omit<ReviewSnapshot, "reviewHash">) {
  return semanticHash(
    JSON.stringify({
      version: value.version,
      scope: value.scope,
      targets: value.targets,
      root: value.root,
      identity: value.identity,
      authorization: value.authorization,
      hash: value.hash,
      diff: semanticHash(value.diff),
      gitHash: value.gitHash,
      reasons: value.reasons,
    }),
  );
}
async function gitMetadata(local: LocalService, root: string, signal: AbortSignal) {
  const status = await local.changes.reader
    .run({ op: "status" }, { cwd: root, signal, maxBytes: 1024 * 1024, timeoutMs: 5000 })
    .catch((error: unknown) => {
      // Source review remains useful without Git, with explicit partial coverage.
      if (error instanceof ExecError && error.code === "git_unavailable") return null;
      throw error;
    });
  if (!status) return null;
  if (status.exitCode !== 0 || status.overflow) return null;
  return {
    raw: status.stdout,
    hash: semanticHash(status.stdout.toString("utf8")),
    ...local.changes.parseStatus(status.stdout),
  };
}
export async function captureReview(
  local: LocalService,
  access: SourceAccess,
  scope: ChangesScope,
  kind: "turn" | "uncommitted",
  runId: string,
): Promise<ReviewSnapshot> {
  const before = await gitMetadata(local, access.root, access.signal);
  // Pi Bot's own output folder (`.pibot/out`: reports, notes, deliverables) is not the code under
  // review. Counting it made a review of a turn that also wrote 改动说明.md there report a partial
  // snapshot (docs guide 2026-11-14); it is left out of the subject instead.
  const names = (
    kind === "turn"
      ? local.changes.turn.repo.summarize(runId).map((f) => f.path)
      : (before?.entries.map((e) => e.path) ?? [])
  ).filter((name) => !/^\.pibot(?:\/|$)/.test(name));
  const targets = [...new Set(names)]
    .slice(0, 200)
    .filter((name) => safePath.safeParse(name).success);
  const project = await captureProject(access, true, targets);
  const reasons = new Set(project.reasons),
    parts: string[] = [];
  if (!before) reasons.add("git_comparison_unavailable");
  if (targets.length !== Math.min(new Set(names).size, 200)) reasons.add("invalid_target_path");
  const included = new Set(project.files.map((f) => f.path));
  let bytes = 0;
  for (const name of names.slice(0, 200)) {
    const absolute = resolve(access.root, name),
      relativePath = relative(access.root, absolute).split(sep).join("/");
    if (!included.has(relativePath) || !(await access.authorize(absolute, "file", access.signal))) {
      reasons.add("changed_file_not_captured");
      continue;
    }
    let patch: string;
    if (kind === "turn") {
      const diff = await local.changes.turnDiff(scope, runId, name, access.signal);
      if (diff.unavailable || diff.tooLarge || diff.binary) {
        reasons.add("turn_diff_unavailable");
        continue;
      }
      patch = JSON.stringify(diff);
    } else if (before?.entries.find((e) => e.path === name)?.status === "untracked") {
      patch = JSON.stringify({
        path: relativePath,
        added: project.files.find((f) => f.path === relativePath)?.text,
      });
    } else if (before?.head) {
      const diff = await local.changes.reader.run(
        { op: "diff", base: before.head, path: name },
        { cwd: access.root, signal: access.signal, maxBytes: 1024 * 1024, timeoutMs: 5000 },
      );
      if (diff.overflow || diff.exitCode !== 0) {
        reasons.add("diff_unavailable");
        continue;
      }
      patch = diff.stdout.toString("utf8");
    } else {
      reasons.add("diff_base_unavailable");
      continue;
    }
    bytes += Buffer.byteLength(patch);
    if (bytes > 1024 * 1024) {
      reasons.add("diff_byte_limit");
      break;
    }
    parts.push(patch);
  }
  if (names.length > 200) reasons.add("changed_file_limit");
  const after = await gitMetadata(local, access.root, access.signal);
  const second = await captureProject(access, true, targets);
  if (before?.hash !== after?.hash || project.hash !== second.hash)
    throw new RpcError(-32602, "review_snapshot_changed");
  const value = {
    version: 1 as const,
    scope: kind,
    targets,
    ...project,
    reasons: [...reasons].slice(0, 30),
    diff: parts.join("\n"),
    gitHash: before?.hash ?? null,
  };
  return { ...value, reviewHash: reviewHash(value) };
}

export class ReviewSnapshotFiles {
  constructor(private readonly dataDir: string) {}
  private path(id: string, botId: string) {
    return join(
      this.dataDir,
      "bots",
      IdSchema.parse(botId),
      "review-snapshots",
      `${IdSchema.parse(id)}.json`,
    );
  }
  size(value: ReviewSnapshot) {
    return Buffer.byteLength(JSON.stringify(ReviewSnapshotSchema.parse(value)));
  }
  async save(id: string, botId: string, value: ReviewSnapshot) {
    const encoded = JSON.stringify(ReviewSnapshotSchema.parse(value));
    if (Buffer.byteLength(encoded) > 32 * 1024 * 1024)
      throw new RpcError(-32602, "review_snapshot_limit");
    await mkdir(join(this.dataDir, "bots", IdSchema.parse(botId), "review-snapshots"), {
      recursive: true,
      mode: 0o700,
    });
    const handle = await open(
      this.path(id, botId),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(encoded);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return Buffer.byteLength(encoded);
  }
  async load(
    id: string,
    botId: string,
    hash: string,
    signal: AbortSignal,
  ): Promise<ReviewSnapshot> {
    signal.throwIfAborted();
    const handle = await open(
      this.path(id, botId),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink > 1 || info.size > 32 * 1024 * 1024)
        throw new RpcError(-32602, "review_snapshot_unavailable");
      const bytes = Buffer.alloc(Math.min(info.size + 1, 32 * 1024 * 1024 + 1));
      let length = 0;
      while (length < bytes.length) {
        signal.throwIfAborted();
        const result = await handle.read(bytes, length, bytes.length - length, null);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      const after = await handle.stat();
      if (
        length !== info.size ||
        after.size !== info.size ||
        after.mtimeMs !== info.mtimeMs ||
        after.ctimeMs !== info.ctimeMs
      )
        throw new RpcError(-32602, "review_snapshot_changed");
      let value: ReviewSnapshot;
      try {
        value = ReviewSnapshotSchema.parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))),
        );
      } catch {
        throw new RpcError(-32602, "review_snapshot_unavailable");
      }
      if (
        value.files.some((f) => semanticHash(f.text) !== f.hash) ||
        snapshotHash(value.files) !== value.hash ||
        reviewHash(value) !== hash ||
        value.reviewHash !== hash
      )
        throw new RpcError(-32602, "review_snapshot_changed");
      return value;
    } finally {
      await handle.close();
    }
  }
  async remove(id: string, botId: string) {
    await unlink(this.path(id, botId)).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
  }
  async current(local: LocalService, access: SourceAccess, snapshot: ReviewSnapshot) {
    const current = await captureProject(access, true, snapshot.targets ?? []),
      git = await gitMetadata(local, access.root, access.signal);
    return (
      current.hash === snapshot.hash &&
      current.identity.device === snapshot.identity.device &&
      current.identity.inode === snapshot.identity.inode &&
      (git?.hash ?? null) === snapshot.gitHash
    );
  }
}
