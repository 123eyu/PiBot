// `pnpm check:changed` said nothing about which content it passed, so a task that kept
// editing after its check was still handed to review with that old pass (its type errors,
// formatting and boundary breaks only failed verify). The check now records a fingerprint of the
// worktree it passed; pibot-dev recomputes it before marking a task 待审 and reruns the check when
// the work moved on. Shared by tools/dev/check-changed.ts and tools/pibot-dev so both sides mean
// exactly the same content — two implementations would drift and void checks for no reason.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Where a passing check leaves its fingerprint, relative to the worktree root (`.cache/` is ignored). */
export const CHECK_PASS_FILE = join(".cache", "check-changed.json");

export interface ChangeFingerprint {
  /** merge-base the diff was taken against, for the log only: the digest is over content. */
  base: string;
  digest: string;
  files: number;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "core.quotepath=off", ...args], {
    encoding: "utf8",
    maxBuffer: 256 << 20,
  });

/**
 * A digest of the worktree's changes against `main`: the diff from their merge-base plus the
 * content of new files nothing tracks yet. Context lines move when main is synced in, but git
 * shows the same hunks for unchanged files, so a sync alone does not void a pass while any edit,
 * added file or new file does.
 *
 * docs/ is left out, as in `changeSet`: every task appends its progress note after its last check,
 * and a note cannot break typecheck, lint or the boundary rules — counting it would rerun the whole
 * check for every task and teach nobody anything.
 */
export function changeFingerprint(worktree: string, against = "main"): ChangeFingerprint {
  const base = git(worktree, "merge-base", "HEAD", against).trim();
  const hash = createHash("sha256").update(
    git(worktree, "diff", "--no-color", "--binary", base, "--", ".", ":(exclude)docs"),
  );
  const tracked = git(worktree, "diff", "--name-only", base)
    .split("\n")
    .filter((file) => file && !file.startsWith("docs/"));
  const untracked = git(worktree, "ls-files", "--others", "--exclude-standard")
    .split("\n")
    .filter((file) => file && !file.startsWith("docs/"))
    .sort();
  for (const file of untracked) {
    let content: Buffer;
    try {
      content = readFileSync(join(worktree, file));
    } catch {
      // Removed between the two git calls: it is not part of the work any more.
      continue;
    }
    hash.update(`\0${file}\0`).update(content);
  }
  return {
    base,
    digest: hash.digest("hex").slice(0, 16),
    files: tracked.length + untracked.length,
  };
}

/** Records the content a passing check was about, with when it ran (the note cites the cost). */
export function recordCheckPass(worktree: string, fingerprint = changeFingerprint(worktree)) {
  mkdirSync(join(worktree, ".cache"), { recursive: true });
  writeFileSync(
    join(worktree, CHECK_PASS_FILE),
    `${JSON.stringify({ ...fingerprint, at: new Date().toISOString() })}\n`,
  );
}

/** The last recorded pass, or undefined when no check passed (or the file is unreadable). */
export function readCheckPass(worktree: string): (ChangeFingerprint & { at?: string }) | undefined {
  try {
    const recorded = JSON.parse(readFileSync(join(worktree, CHECK_PASS_FILE), "utf8")) as unknown;
    const digest = (recorded as { digest?: unknown } | null)?.digest;
    return typeof digest === "string" ? (recorded as ChangeFingerprint) : undefined;
  } catch {
    // No pass recorded yet, or a half-written file: the workflow reruns the check, which is the
    // safe outcome either way.
    return undefined;
  }
}

/** A check that starts or fails must not leave an older pass looking current. */
export function clearCheckPass(worktree: string) {
  rmSync(join(worktree, CHECK_PASS_FILE), { force: true });
}
