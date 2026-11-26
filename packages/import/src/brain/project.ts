// A reviewed diff grants one conditional write to the selected project's AGENTS.md.
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { type CapabilityContext, writeReviewedProjectNotes } from "@pibot/brain/kit";
import { createFileTools, directoryIdentity, sensitiveReadBoundary } from "@pibot/execution";
import type { ImportPreview } from "@pibot/import-contract";
import { nodeFileSystem, protectedPaths } from "@pibot/policy";
import { RpcError } from "@pibot/protocol-base";
import type { ImportProjects, ProjectReceipt } from "../store/projects.ts";
import type { ImportInput } from "./adapter.ts";
import { exportItems } from "./exports/index.ts";
import { readProjectNote } from "./local/text.ts";
import { redactImportText } from "./records.ts";

const file = "AGENTS.md";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const unavailable = () => new RpcError(-32602, "import_project_unavailable");
export type ProjectReview = {
  reviewId: string;
  folder: string;
  diff: string;
  receipt: ProjectReceipt;
  content: string;
  assertSource(signal: AbortSignal): Promise<void>;
};

export class ProjectImport {
  private readonly files = createFileTools();
  constructor(
    private readonly ctx: CapabilityContext,
    private readonly store: ImportProjects,
  ) {}

  async review(preview: ImportPreview, input: ImportInput, signal: AbortSignal) {
    if (
      !this.ctx.host.pickFolder ||
      (!input.projectNote && (!preview.exportDetails?.projects || preview.source !== "claude"))
    )
      throw unavailable();
    const picked = await this.ctx.host.pickFolder(signal);
    signal.throwIfAborted();
    if (!picked) return null;
    const { canonicalPath: root, device, inode } = await directoryIdentity(picked);
    const identity = { root, device, inode };
    const before = await this.read(identity, signal);
    if (redactImportText(this.ctx.redactor, before) !== before) throw unavailable();
    const notes: string[] = [];
    let size = 0;
    const items = input.projectNote
      ? [{ kind: "projects" as const, text: await readProjectNote(input, signal) }]
      : exportItems("claude", input, signal);
    for await (const item of items) {
      if (item.kind !== "projects") continue;
      const text = redactImportText(this.ctx.redactor, item.text).replaceAll("\0", "").trim();
      size += Buffer.byteLength(text);
      if (size > 8000 || notes.length >= 100) throw unavailable();
      if (text) notes.push(text);
    }
    if (!notes.length) throw unavailable();
    const eol = before.includes("\r\n") ? "\r\n" : "\n";
    const lines = [
      "",
      "## Imported project notes / 导入的项目笔记",
      "",
      ...notes
        .join("\n\n")
        .split(/\r?\n/u)
        .map((line) => `> ${line}`),
      "",
    ];
    const content = before + eol + lines.join(eol);
    if (Buffer.byteLength(content) > 128 * 1024 || content.split("\n").length > 2000)
      throw unavailable();
    const folder = redactImportText(this.ctx.redactor, root).slice(0, 4096);
    const diff = ["--- AGENTS.md", "+++ AGENTS.md", ...lines.map((line) => `+${line}`)].join("\n");
    return {
      reviewId: randomUUID(),
      folder,
      diff,
      receipt: { ...identity, before, hash: hash(content) },
      content,
      async assertSource(current: AbortSignal) {
        if (input.file) {
          // The native source iterator rechecks permission and identity at both ends, even without reading its body.
          for await (const _file of input.file(current)) current.throwIfAborted();
        } else if (input.projectNote) {
          await readProjectNote(input, current);
        }
      },
    };
  }

  async apply(importId: string, botId: string, review: ProjectReview, signal: AbortSignal) {
    const { receipt, content, diff } = review;
    if (redactImportText(this.ctx.redactor, content) !== content) throw unavailable();
    await this.context(receipt, signal);
    signal.throwIfAborted();
    this.store.remember(importId, botId, receipt);
    await writeReviewedProjectNotes(
      this.ctx.local,
      {
        botId,
        ...receipt,
        content,
        expectedHash: hash(receipt.before),
        diff,
        assertSource: review.assertSource,
        assertCurrent: () => this.store.assertCurrent(importId, botId, receipt, "apply"),
      },
      signal,
    );
  }

  async assertUndoable(importId: string, signal: AbortSignal) {
    if (this.store.hasDependents(importId)) throw unavailable();
    const receipt = this.store.pending(importId);
    if (!receipt) return;
    const current = hash(await this.read(receipt, signal));
    if (current !== receipt.hash && current !== hash(receipt.before)) throw unavailable();
  }

  async restore(importId: string, botId: string, caller: AbortSignal) {
    const signal = AbortSignal.any([caller, AbortSignal.timeout(90_000)]);
    await this.assertUndoable(importId, signal);
    const receipt = this.store.pending(importId);
    if (!receipt) return;
    const currentText = await this.read(receipt, signal);
    if (hash(currentText) === hash(receipt.before)) {
      this.store.assertCurrent(importId, botId, receipt, "restore");
      this.store.settle(importId, "restored");
      return;
    }
    if (hash(currentText) !== receipt.hash) throw unavailable();
    // A blocked or refused compensation keeps the durable receipt and cleanup phase for retry.
    await writeReviewedProjectNotes(
      this.ctx.local,
      {
        botId,
        ...receipt,
        content: receipt.before,
        expectedHash: receipt.hash,
        assertCurrent: () => this.store.assertCurrent(importId, botId, receipt, "restore"),
        diff: [
          "--- AGENTS.md",
          "+++ AGENTS.md",
          ...currentText.split(/\r?\n/u).map((line) => `-${line}`),
          ...receipt.before.split(/\r?\n/u).map((line) => `+${line}`),
        ].join("\n"),
      },
      signal,
    );
    this.store.settle(importId, "restored");
  }

  private async read(identity: Omit<ProjectReceipt, "before" | "hash">, signal: AbortSignal) {
    const context = await this.context(identity, signal);
    const value = await this.files.readFile(context);
    if (value.type !== "text" || value.truncated || value.size > 128 * 1024) throw unavailable();
    return value.text;
  }

  private async context(
    { root, device, inode }: Omit<ProjectReceipt, "before" | "hash">,
    signal: AbortSignal,
  ) {
    const { platform, userHome, env, dataDir } = this.ctx.local.deps;
    const path = join(root, file);
    const assertPolicy = async () => {
      signal.throwIfAborted();
      const sensitive = await sensitiveReadBoundary(platform, [userHome], env);
      const policy = await protectedPaths(
        {
          platform,
          home: userHome,
          cwd: root,
          roots: [root],
          fs: nodeFileSystem,
          signal,
        },
        [...sensitive.denyRead, dataDir],
      );
      if (policy.covers(root) || policy.covers(path)) throw unavailable();
    };
    await assertPolicy();
    return {
      path,
      signal,
      expectedPath: path,
      cwd: root,
      writeRoots: [root],
      rootIdentities: [{ canonicalPath: root, device, inode }],
      confirmDispatch: assertPolicy,
    };
  }
}
