// Preserve the pre-write copy until a refused or cancelled project change is settled.
import type { DatabaseSync } from "node:sqlite";
import { transaction } from "@pibot/storage";
import { z } from "zod";
import { ImportFailure } from "./failure.ts";

const project = z.object({
  root: z.string(),
  device: z.string(),
  inode: z.string(),
  before: z.string(),
  hash: z.string(),
});

export type ProjectReceipt = z.infer<typeof project>;

export class ImportProjects {
  constructor(private readonly db: DatabaseSync) {}

  remember(importId: string, botId: string, value: ProjectReceipt) {
    transaction(this.db, () => {
      if (!this.applying(importId, botId) || this.compensating(value.root, importId))
        throw new ImportFailure("project");
      const existing = this.pending(importId);
      if (existing) {
        if (!this.same(existing, value)) throw new ImportFailure("project");
        return;
      }
      this.db
        .prepare(`INSERT INTO import_project_files
        (import_id,root,device,inode,before_text,written_hash,state)
        VALUES(?,?,?,?,?,?,'pending')`)
        .run(importId, value.root, value.device, value.inode, value.before, value.hash);
    });
  }

  compensating(root: string, exceptId = "") {
    return !!this.db
      .prepare(`SELECT 1 FROM import_project_files p
      JOIN import_jobs j ON j.id=p.import_id
      WHERE p.root=? AND p.import_id<>? AND p.state='pending'
        AND j.cleanup_phase IS NOT NULL LIMIT 1`)
      .get(root, exceptId);
  }

  assertCurrent(importId: string, botId: string, value: ProjectReceipt, mode: "apply" | "restore") {
    transaction(this.db, () => {
      const current = this.pending(importId);
      const cleaning = !!this.db
        .prepare(`SELECT 1 FROM import_jobs
        WHERE id=? AND bot_id=? AND cleanup_phase IS NOT NULL`)
        .get(importId, botId);
      if (
        !current ||
        !this.same(current, value) ||
        (mode === "apply"
          ? !this.applying(importId, botId) || this.compensating(value.root, importId)
          : !cleaning || this.hasDependents(importId))
      )
        throw new ImportFailure("project");
    });
  }

  private applying(importId: string, botId: string) {
    return !!this.db
      .prepare(`SELECT 1 FROM import_jobs
      WHERE id=? AND bot_id=? AND state='running' AND cleanup_phase IS NULL`)
      .get(importId, botId);
  }

  private same(left: ProjectReceipt, right: ProjectReceipt) {
    return (
      left.root === right.root &&
      left.device === right.device &&
      left.inode === right.inode &&
      left.before === right.before &&
      left.hash === right.hash
    );
  }

  pending(importId: string) {
    const row = this.db
      .prepare(`SELECT root,device,inode,before_text AS before,written_hash AS hash
      FROM import_project_files WHERE import_id=? AND state='pending'`)
      .get(importId);
    return row ? project.parse(row) : undefined;
  }

  hasDependents(importId: string) {
    return !!this.db
      .prepare(`SELECT 1 FROM import_project_files original
      JOIN import_project_files later ON later.root=original.root
        AND later.device=original.device AND later.inode=original.inode
        AND later.rowid>original.rowid AND later.state='pending'
      WHERE original.import_id=? AND original.state='pending' LIMIT 1`)
      .get(importId);
  }

  settle(importId: string, state: "restored" | "kept") {
    this.db
      .prepare(`UPDATE import_project_files
      SET before_text='',root='',device='',inode='',written_hash='',state=?
      WHERE import_id=? AND state='pending'`)
      .run(state, importId);
  }
}
