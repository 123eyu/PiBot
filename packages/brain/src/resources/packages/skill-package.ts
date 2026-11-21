import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { extname, join } from "node:path";
import { SKILL_PACKAGE_MAX_DEPTH, skillPackagePathSafe } from "@pibot/protocol-base";

/** One file of a skill package, path relative to the folder that holds SKILL.md. */
export interface PackageFile {
  path: string;
  data: Buffer;
  /** UTF-8 without NUL; only these can be viewed in the preview. */
  text: boolean;
  script: boolean;
}
export class PackageError extends Error {
  /** The entry that broke a rule, when the walk knows it; callers may name it to the user. */
  constructor(
    message: string,
    readonly path?: string,
  ) {
    super(message);
  }
}

const MAX_DEPTH = SKILL_PACKAGE_MAX_DEPTH;
const SKILL_FILE = "skill.md";

// Version-control folders, caches, local runtime environments and OS metadata are not part of a
// skill and would only push a cloned folder over the file limit. Environments in particular hold
// interpreter symlinks that the import refuses (ppt-master's .venv, 2026-11-14); Pi Bot builds its
// own environment for a skill, so a source tool's copy is never needed.
const JUNK_DIRS = new Set([
  ".git",
  ".svn",
  ".hg",
  "__MACOSX",
  "__pycache__",
  ".venv",
  "venv",
  "node_modules",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
]);
const JUNK_FILES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);
export function junkPath(path: string): boolean {
  const parts = path.split("/");
  const name = parts.at(-1) ?? "";
  return (
    parts.slice(0, -1).some((part) => JUNK_DIRS.has(part)) ||
    JUNK_FILES.has(name.toLowerCase()) ||
    name.startsWith("._")
  );
}

/** Rules in `skillPackagePathSafe`; names are compared in NFC so macOS and zip spellings match. */
export function packagePath(raw: string): string {
  const path = raw.normalize("NFC");
  if (!skillPackagePathSafe(path)) throw new PackageError("unsafe", raw);
  return path;
}

// Interpreted or shell-run scripts, by extension; anything starting with `#!` counts too.
const SCRIPT_EXTENSIONS = new Set([
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ksh",
  ".command",
  ".py",
  ".pyw",
  ".js",
  ".cjs",
  ".mjs",
  ".ts",
  ".cts",
  ".mts",
  ".rb",
  ".pl",
  ".pm",
  ".php",
  ".lua",
  ".r",
  ".ps1",
  ".psm1",
  ".bat",
  ".cmd",
  ".vbs",
  ".wsf",
  ".applescript",
  ".scpt",
  ".jxa",
  ".swift",
  ".go",
  ".jar",
]);
const PROGRAM_EXTENSIONS = new Set([".exe", ".dll", ".so", ".dylib", ".msi", ".com"]);
// ELF, Mach-O (both byte orders, 32/64-bit, universal) and Windows PE.
function nativeProgram(head: Buffer): boolean {
  if (head.length >= 4) {
    const magic = head.readUInt32BE(0);
    if (
      magic === 0x7f454c46 ||
      magic === 0xfeedface ||
      magic === 0xfeedfacf ||
      magic === 0xcefaedfe ||
      magic === 0xcffaedfe ||
      magic === 0xcafebabe
    )
      return true;
  }
  return head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a;
}
/** Only the first bytes matter, so a saved skill can be classified without reading it whole. */
export function scriptLike(path: string, head: Buffer): boolean {
  const extension = extname(path).toLowerCase();
  return (
    SCRIPT_EXTENSIONS.has(extension) ||
    PROGRAM_EXTENSIONS.has(extension) ||
    (head[0] === 0x23 && head[1] === 0x21) ||
    nativeProgram(head)
  );
}

export function textOf(data: Buffer): string | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    return text.includes("\0") ? undefined : text;
  } catch {
    return undefined;
  }
}

export interface RawEntry {
  path: string;
  data: Buffer;
}
export interface SkillPackage {
  /** Text of the package's own SKILL.md (any letter case). */
  skillText: string;
  /** Name of the folder holding SKILL.md, "" when it sits at the top. */
  folder: string;
  /** Everything else under that folder, in a stable order. */
  files: PackageFile[];
  totalBytes: number;
  skipped: number;
}

/**
 * Agent Skills layout: the shallowest SKILL.md marks the package root; only files under that
 * folder are imported. Two SKILL.md files at the same shallowest depth are ambiguous.
 */
export function skillPackage(entries: RawEntry[]): SkillPackage {
  const seen = new Set<string>();
  const normalized = entries.map((entry) => {
    const path = packagePath(entry.path);
    // Windows and macOS folders are case-insensitive; two names that collide would overwrite.
    const key = path.toLowerCase();
    if (seen.has(key)) throw new PackageError("unsafe", path);
    seen.add(key);
    return { ...entry, path };
  });
  const depth = (path: string) => path.split("/").length;
  const candidates = normalized
    .filter((entry) => entry.path.split("/").at(-1)?.toLowerCase() === SKILL_FILE)
    .sort((a, b) => depth(a.path) - depth(b.path));
  const skill = candidates[0];
  if (!skill || (candidates[1] && depth(candidates[1].path) === depth(skill.path)))
    throw new PackageError("no_skill");
  const prefix = skill.path.slice(0, skill.path.length - SKILL_FILE.length);
  const skillText = textOf(skill.data);
  if (skillText === undefined) throw new PackageError("no_skill");
  const files: PackageFile[] = [];
  let skipped = 0;
  let totalBytes = skill.data.length;
  for (const entry of normalized) {
    if (entry === skill) continue;
    if (!entry.path.startsWith(prefix)) {
      skipped++;
      continue;
    }
    const text = textOf(entry.data) !== undefined;
    const path = entry.path.slice(prefix.length);
    files.push({ path, data: entry.data, text, script: scriptLike(path, entry.data) });
    totalBytes += entry.data.length;
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    skillText,
    folder: prefix.split("/").at(-2) ?? "",
    files,
    totalBytes,
    skipped,
  };
}

/**
 * Reads a picked folder. Sizes are checked from `lstat` before anything is read, links and
 * special files are refused (they could point the saved skill elsewhere), and each file is
 * opened without following links so a swap after the walk cannot redirect the read.
 */
export async function readFolder(root: string, signal: AbortSignal): Promise<RawEntry[]> {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) throw new PackageError("unsafe");
  const found: { path: string; absolute: string; size: number }[] = [];
  let total = 0;
  const walk = async (folder: string, relative: string[]) => {
    if (relative.length >= MAX_DEPTH) throw new PackageError("unsafe", relative.join("/"));
    const directory = await opendir(folder);
    for await (const entry of directory) {
      signal.throwIfAborted();
      const parts = [...relative, entry.name];
      const path = parts.join("/");
      const absolute = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!JUNK_DIRS.has(entry.name)) await walk(absolute, parts);
        continue;
      }
      if (junkPath(path)) continue;
      // A link, FIFO or socket inside the package: name it so the user can remove that file.
      if (!entry.isFile()) throw new PackageError("unsafe", path);
      const stat = await lstat(absolute);
      if (!stat.isFile()) throw new PackageError("unsafe", path);
      if (stat.size > 5 * 1024 * 1024) throw new PackageError("too_large");
      total += stat.size;
      if (total > 20 * 1024 * 1024) throw new PackageError("too_large");
      if (found.length >= 500) throw new PackageError("too_many_files");
      found.push({ path, absolute, size: stat.size });
    }
  };
  await walk(root, []);
  const entries: RawEntry[] = [];
  for (const item of found) {
    signal.throwIfAborted();
    const file = await open(
      item.absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== item.size) throw new PackageError("changed");
      const data = await file.readFile({ signal });
      if (data.length !== item.size) throw new PackageError("changed");
      entries.push({ path: item.path, data });
    } finally {
      await file.close();
    }
  }
  return entries;
}
