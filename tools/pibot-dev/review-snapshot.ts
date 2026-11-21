import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { changeSet } from "./changes.ts";
import { git, now, record, store } from "./context.ts";
import type { TaskRecord } from "./state.ts";
import { syncMain } from "./worktree.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export function review(task: TaskRecord) {
  if (["running", "testing", "sync_conflict", "finished"].includes(task.status))
    throw new Error("Task is not idle for review");
  if (task.finishState) {
    const phase = task.finishState;
    let merged = false;
    if (phase.commitOid) {
      try {
        git(task.worktree, "merge-base", "--is-ancestor", phase.commitOid, "main");
        merged = true;
      } catch (error) {
        if ((error as { status?: number }).status !== 1) throw error;
      }
    }
    if (merged || ["merged", "recorded", "cleaned"].includes(phase.phase))
      throw new Error("Resume finish before reviewing a merged task");
  }
  syncMain(task);
  const changes = changeSet(task);
  mkdirSync(join(store.dir, "reviews"), { recursive: true });
  const diffFile = join(store.dir, "reviews", `${task.id}.diff`);
  writeFileSync(diffFile, changes.text);
  store.update((all) => {
    const held = all.tasks[task.id];
    if (!held) throw new Error("Task disappeared");
    delete held.finishState;
    held.reviewSnapshot = {
      digest: changes.digest,
      baseOid: changes.baseOid,
      diffHash: hash(changes.text),
      diffFile,
    };
  });
  return { ...changes, diffFile };
}

export function approve(task: TaskRecord, file: string) {
  const held = store.read().tasks[task.id];
  if (!held || ["running", "testing", "sync_conflict", "finished"].includes(held.status))
    throw new Error("Task is not idle for approval");
  const snapshot = held.reviewSnapshot;
  if (!snapshot?.digest.startsWith("v2:"))
    throw new Error("Prepare a new exact review snapshot first");
  const text = readFileSync(file, "utf8").trim();
  const verdict = text.split("\n").at(-1)?.trim();
  if (verdict !== "review:pass" && verdict !== "review:changes-required")
    throw new Error("Review must end with its verdict");
  const match = /^source-digest: (v2:[a-f0-9]{64})$/m.exec(text)?.[1];
  if (
    match !== snapshot.digest ||
    hash(readFileSync(snapshot.diffFile, "utf8")) !== snapshot.diffHash
  )
    throw new Error("Review file is not bound to the displayed snapshot");
  const changes = changeSet(task);
  if (changes.digest !== snapshot.digest || changes.baseOid !== snapshot.baseOid)
    throw new Error("Source changed after review; prepare a new snapshot");
  const pass = verdict === "review:pass";
  record(
    task.id,
    {
      step: "review",
      at: now(),
      outcome: pass ? "ok" : "failed",
      detail: file,
      diffDigest: snapshot.digest,
    },
    { status: pass ? "passed" : "changes_requested" },
  );
  return { pass, digest: snapshot.digest };
}
