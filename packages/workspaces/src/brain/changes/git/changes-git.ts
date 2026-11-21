import { createHash } from "node:crypto";
import type { ChangeCommit, DiffHunk } from "@pibot/workspaces-contract/full";

/** Pure parsers for the fixed Git output formats requested by @pibot/execution's read-only runner. */
export type ChangeKind =
  | "modified"
  | "added"
  | "deleted"
  | "untracked"
  | "typechange"
  | "conflicted";
export interface StatusEntry {
  path: string;
  status: ChangeKind;
  /** Present in HEAD: discarding restores it; otherwise discarding deletes it. */
  inHead: boolean;
}
export interface LineStats {
  added: number | null;
  removed: number | null;
  binary: boolean;
}

const ordinary = /^1 (\S\S) (\S+) (\d+) (\d+) (\d+) (\S+) (\S+) ([\s\S]+)$/;
const renamed = /^2 (\S\S) (\S+) (\d+) (\d+) (\d+) (\S+) (\S+) (\S+) ([\s\S]+)$/;
const unmerged = /^u (\S\S) (\S+) (\d+) (\d+) (\d+) (\d+) (\S+) (\S+) (\S+) ([\s\S]+)$/;

function kindOf(xy: string, headMode: string): ChangeKind {
  const [x, y] = [xy[0], xy[1]];
  if (headMode === "000000") return "added";
  if (x === "D" || y === "D") return "deleted";
  if (x === "T" || y === "T") return "typechange";
  return "modified";
}

export function parseStatus(raw: Buffer, subdirectory: string | null = null) {
  const tokens = raw.toString("utf8").split("\0");
  let branch: string | null = null;
  let head: string | null = null;
  const entries: StatusEntry[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] as string;
    if (!token) continue;
    if (token.startsWith("# branch.oid ")) {
      const value = token.slice(13);
      head = value === "(initial)" ? null : value;
    } else if (token.startsWith("# branch.head ")) {
      const value = token.slice(14);
      branch = value === "(detached)" ? null : value;
    } else if (token.startsWith("? ")) {
      entries.push({ path: token.slice(2), status: "untracked", inHead: false });
    } else if (token.startsWith("1 ")) {
      const match = ordinary.exec(token);
      if (match)
        entries.push({
          path: match[8] as string,
          status: kindOf(match[1] as string, match[3] as string),
          inHead: match[3] !== "000000",
        });
    } else if (token.startsWith("2 ")) {
      // --no-renames should prevent these; a staged rename still lists its new path.
      const match = renamed.exec(token);
      index++;
      if (match)
        entries.push({
          path: match[9] as string,
          status: kindOf(match[1] as string, match[3] as string),
          inHead: match[3] !== "000000",
        });
    } else if (token.startsWith("u ")) {
      const match = unmerged.exec(token);
      if (match) entries.push({ path: match[10] as string, status: "conflicted", inHead: true });
    }
  }
  entries.sort((a, b) => compare(a.path, b.path));
  return { branch, head, entries: subdirectory ? within(entries, subdirectory) : entries };
}

/**
 * Porcelain status prints repository-relative paths even with a `.` pathspec; the pane shows them
 * relative to the folder, and anything outside it (which the pathspec should already exclude) is
 * dropped rather than shown.
 */
function within(entries: StatusEntry[], subdirectory: string) {
  const prefix = `${subdirectory}/`;
  return entries
    .filter((entry) => entry.path.startsWith(prefix) && entry.path.length > prefix.length)
    .map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }));
}

export function compare(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `diff --numstat -z` without renames: one "added\tremoved\tpath" token per file. */
export function parseNumstat(raw: Buffer | string) {
  const stats = new Map<string, LineStats>();
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  for (const token of text.split(/\0|\n/)) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(token);
    if (!match) continue;
    const binary = match[1] === "-";
    stats.set(match[3] as string, {
      added: binary ? null : Number(match[1]),
      removed: binary ? null : Number(match[2]),
      binary,
    });
  }
  return stats;
}

/** `show -z --raw --numstat`: raw records give the kind, numstat tokens the line counts. */
export function parseCommitFiles(raw: Buffer) {
  const tokens = raw.toString("utf8").split("\0");
  const files = new Map<string, { status: ChangeKind } & LineStats>();
  for (let index = 0; index < tokens.length; index++) {
    const token = (tokens[index] as string).replace(/^\n+/, "");
    if (token.startsWith(":")) {
      const letter = token.trim().split(" ").at(-1)?.[0];
      const path = tokens[++index] as string;
      if (!path) continue;
      files.set(path, {
        status:
          letter === "A"
            ? "added"
            : letter === "D"
              ? "deleted"
              : letter === "T"
                ? "typechange"
                : "modified",
        added: null,
        removed: null,
        binary: false,
      });
      continue;
    }
    const stat = parseNumstat(token);
    for (const [path, value] of stat) {
      const file = files.get(path);
      if (file) Object.assign(file, value);
    }
  }
  return files;
}

export interface ParsedDiff {
  binary: boolean;
  header: string[];
  hunks: DiffHunk[];
}

/** Hunks keep raw lines; the digest binds a later discard to exactly what the user saw. */
export function parseDiff(text: string): ParsedDiff {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const header: string[] = [];
  const hunks: DiffHunk[] = [];
  let binary = false;
  let current: DiffHunk | undefined;
  const close = () => {
    if (!current) return;
    current.digest = hunkDigest(current.header, current.lines);
    hunks.push(current);
    current = undefined;
  };
  for (const line of lines) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      close();
      current = {
        index: hunks.length,
        header: line,
        oldStart: Number(match[1]),
        oldLines: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newLines: match[4] === undefined ? 1 : Number(match[4]),
        lines: [],
        digest: "",
      };
    } else if (line.startsWith("diff --git ") && current) {
      // Only one file is requested; a second header would mean unexpected output.
      close();
      break;
    } else if (current) current.lines.push(line);
    else {
      if (line.startsWith("Binary files ") || line === "GIT binary patch") binary = true;
      header.push(line);
    }
  }
  close();
  return { binary, header, hunks };
}

export function hunkDigest(header: string, lines: string[]) {
  return createHash("sha256").update(header).update("\n").update(lines.join("\n")).digest("hex");
}

export function parseLog(raw: Buffer): ChangeCommit[] {
  return raw
    .toString("utf8")
    .split("\x1e")
    .map((record) => record.replace(/^\n+/, ""))
    .filter(Boolean)
    .map((record) => {
      const [oid, author, email, at, subject] = record.split("\x1f");
      return {
        oid: oid as string,
        author: author ?? "",
        email: email ?? "",
        time: new Date(Number(at) * 1000).toISOString(),
        subject: subject ?? "",
      };
    });
}

/**
 * `log --files`: each record opens with \x1e, its fields end with \x1f, and the -z name list of
 * the files it changed follows ("N files" per commit).
 */
export function parseLogFiles(raw: Buffer): ChangeCommit[] {
  return raw
    .toString("utf8")
    .split("\x1e")
    .filter((record) => record.includes("\x1f"))
    .map((record) => {
      const [oid, author, email, at, subject, names = ""] = record.split("\x1f");
      return {
        oid: (oid ?? "").trim(),
        author: author ?? "",
        email: email ?? "",
        time: new Date(Number(at) * 1000).toISOString(),
        subject: subject ?? "",
        files: names.split("\0").filter((name) => name.trim()).length,
      };
    });
}

const lockFiles = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "Gemfile.lock",
  "composer.lock",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "go.sum",
  "flake.lock",
  "Podfile.lock",
  "pubspec.lock",
  "mix.lock",
]);
const generatedDirectories = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "target",
  "vendor",
  "__pycache__",
  "coverage",
  "Pods",
  "DerivedData",
  ".gradle",
]);
/** Lock files, build output and dependencies go to the last, collapsed group. */
export function isGenerated(path: string) {
  const parts = path.split("/");
  const name = parts.at(-1) ?? "";
  return (
    lockFiles.has(name) ||
    parts.slice(0, -1).some((part) => generatedDirectories.has(part)) ||
    /\.min\.(?:js|css)$|\.map$|\.pb\.go$|_pb2\.py$|\.g\.dart$/.test(name)
  );
}
