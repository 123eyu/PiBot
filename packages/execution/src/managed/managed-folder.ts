import { createHash } from "node:crypto";
import { lstat, mkdir, opendir, readFile, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { ExecError, type ExecOptions } from "../core/types.ts";
import { findGit, type GitProcessOptions, spawnGit } from "../git/git-process.ts";
import { gitHardening } from "../git/git-program.ts";

/**
 * Group plans on a folder that is not a usable Git repository (maintainers 2026-11-14): Pi Bot keeps
 * its own repository under `<folder>/.pibot/managed-git/<id>` so plan steps can branch managed
 * worktrees from it. The folder itself never gets a `.git` and Git never runs in it; files move
 * between the folder and this repository by plain, bounded copies checked against a manifest of
 * what each side last agreed on, so a file someone else changed is a conflict, never overwritten.
 */
const CONTAINER = [".pibot", "managed-git"] as const;
const MANIFEST = "pibot-folder.json";
const MAX_FILES = 5_000;
const MAX_BYTES = 200 * 1024 * 1024;
/** Bigger files stay only in the folder: members can still read them there. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Never copied: Pi Bot's own metadata, other repositories, dependency trees and secrets. */
const SKIP_DIRS = new Set([
  ".pibot",
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".ssh",
  ".aws",
  ".gnupg",
  ".Trash",
]);
const SKIP_FILES = new Set([".DS_Store", ".netrc", ".npmrc", ".git-credentials", ".gitconfig"]);
const ManifestSchema = z.strictObject({
  version: z.literal(1),
  files: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
});
type Manifest = z.infer<typeof ManifestSchema>;
type Tree = Map<string, { hash: string; size: number }>;

export class ManagedFolderError extends ExecError {
  constructor(
    readonly folderCode:
      | "managed_folder_too_large"
      | "managed_folder_unsafe"
      | "managed_folder_git_failed",
  ) {
    super("invalid_input");
  }
}

export function managedFolderRepository(folder: string, id: string) {
  if (!ID.test(id)) throw new ManagedFolderError("managed_folder_unsafe");
  return join(folder, ...CONTAINER, id);
}

/** The repository belongs to `folder` only at this exact place; anything else is foreign. */
export function isManagedFolderRepository(folder: string, path: string) {
  const parts = relative(folder, path).split(sep);
  return (
    parts.length === 3 &&
    parts[0] === CONTAINER[0] &&
    parts[1] === CONTAINER[1] &&
    ID.test(parts[2] ?? "")
  );
}

function skipped(name: string) {
  return (
    SKIP_FILES.has(name) ||
    name === ".env" ||
    name.startsWith(".env.") ||
    /\.(?:pem|p12|pfx|key)$/i.test(name) ||
    /[\0\r\n]/.test(name)
  );
}

/** Regular files only (no links, devices or hard-linked files), bounded by count and size. */
async function walk(root: string, exclude: readonly string[], signal: AbortSignal) {
  const files: Tree = new Map();
  let bytes = 0;
  const visit = async (directory: string) => {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      signal.throwIfAborted();
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || exclude.some((item) => item === path)) continue;
        await visit(path);
        continue;
      }
      if (!entry.isFile() || skipped(entry.name)) continue;
      const info = await lstat(path);
      if (!info.isFile() || info.nlink !== 1 || info.size > MAX_FILE_BYTES) continue;
      bytes += info.size;
      if (files.size >= MAX_FILES || bytes > MAX_BYTES)
        throw new ManagedFolderError("managed_folder_too_large");
      const hash = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
      files.set(relative(root, path).split(sep).join("/"), { hash, size: info.size });
    }
  };
  await visit(root);
  return files;
}

async function fileHash(path: string) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.nlink !== 1) return "foreign";
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Parents are created as real directories only; a link anywhere on the way is refused. */
async function realParents(root: string, path: string) {
  let current = root;
  for (const part of relative(root, dirname(path)).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (!info.isDirectory()) throw new ManagedFolderError("managed_folder_unsafe");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current).catch((failure: NodeJS.ErrnoException) => {
        if (failure.code !== "EEXIST") throw failure;
      });
      if (!(await lstat(current)).isDirectory())
        throw new ManagedFolderError("managed_folder_unsafe");
    }
  }
}

function inside(root: string, relativePath: string) {
  const absolute = resolve(root, ...relativePath.split("/"));
  if (absolute === root || !absolute.startsWith(`${root}${sep}`))
    throw new ManagedFolderError("managed_folder_unsafe");
  return absolute;
}

export function createManagedFolders(
  options: Pick<ExecOptions, "platform" | "env" | "tempDir" | "resourcesDir">,
) {
  // An empty HOME: the user's global Git config (filters, hooks, signing) never applies here.
  const home = join(options.tempDir, "managed-folder-home");
  const processOptions: GitProcessOptions = {
    platform: options.platform,
    env: options.env,
    userHome: home,
    resourcesDir: options.resourcesDir,
  };
  async function git(repository: string, args: string[], signal: AbortSignal) {
    const program = await findGit(processOptions);
    if (!program) throw new ExecError("git_unavailable");
    await mkdir(home, { recursive: true, mode: 0o700 });
    const result = await spawnGit(processOptions, {
      executable: program,
      args: [
        ...gitHardening(options.platform, program),
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.safecrlf=false",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "init.defaultBranch=main",
        "-c",
        "user.name=Pi Bot",
        "-c",
        "user.email=pibot@localhost",
        ...(options.platform === "win32" ? ["-c", `safe.directory=${repository}`] : []),
        ...args,
      ],
      cwd: repository,
      signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      cancelled: () => signal.aborted,
      maxBytes: 4 * 1024 * 1024,
    });
    if (result.exitCode !== 0 || result.overflow)
      throw new ManagedFolderError("managed_folder_git_failed");
    return result.stdout.toString("utf8");
  }
  // One operation per repository at a time: steps of one plan start together and share it.
  const chains = new Map<string, Promise<unknown>>();
  function serial<T>(repository: string, operation: () => Promise<T>): Promise<T> {
    const prior = chains.get(repository) ?? Promise.resolve();
    const next = prior.then(operation, operation);
    const tail = next.catch(() => {});
    chains.set(repository, tail);
    void tail.then(() => {
      if (chains.get(repository) === tail) chains.delete(repository);
    });
    return next;
  }
  async function manifest(repository: string): Promise<Manifest> {
    try {
      return ManifestSchema.parse(
        JSON.parse(await readFile(join(repository, ".git", MANIFEST), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, files: {} };
      throw new ManagedFolderError("managed_folder_unsafe");
    }
  }
  const save = (repository: string, value: Manifest) =>
    writeFile(join(repository, ".git", MANIFEST), JSON.stringify(value), { mode: 0o600 });
  async function commit(repository: string, message: string, signal: AbortSignal, first = false) {
    await git(repository, ["add", "-A", "--", "."], signal);
    // The first commit exists even for an empty folder: worktrees branch from a real HEAD.
    if (!first && !(await git(repository, ["status", "--porcelain", "-z"], signal))) return false;
    await git(
      repository,
      ["commit", "-q", "--no-verify", ...(first ? ["--allow-empty"] : []), "-m", message],
      signal,
    );
    return true;
  }
  const ops = {
    /**
     * Brings the folder's current files into the repository (first call creates it with a base
     * commit). The folder side wins only where it changed since the last agreement, so merged
     * results that were already written back are never replaced by older copies.
     */
    async sync(input: {
      folder: string;
      repository: string;
      exclude: readonly string[];
      signal: AbortSignal;
    }) {
      const { folder, repository, signal } = input;
      if (!isManagedFolderRepository(folder, repository))
        throw new ManagedFolderError("managed_folder_unsafe");
      await realParents(folder, join(repository, "x"));
      const fresh = (await fileHash(join(repository, ".git", "HEAD"))) === undefined;
      if (fresh) {
        await git(repository, ["init", "-q"], signal);
        // Worktrees later live in `.pibot/wt` beside the checkout; they are never content.
        await writeFile(join(repository, ".git", "info", "exclude"), ".pibot\n");
      }
      const known = await manifest(repository);
      const source = await walk(folder, [...input.exclude, join(folder, CONTAINER[0])], signal);
      const copy = await walk(repository, [], signal);
      for (const [path, file] of source) {
        if (known.files[path] === file.hash) continue;
        if (copy.get(path)?.hash !== file.hash) {
          const target = inside(repository, path);
          await realParents(repository, target);
          await writeFile(target, await readFile(inside(folder, path)));
        }
        known.files[path] = file.hash;
      }
      for (const [path, hash] of Object.entries(known.files)) {
        if (source.has(path)) continue;
        if (copy.get(path)?.hash === hash) await unlink(inside(repository, path));
        delete known.files[path];
      }
      const changed = await commit(repository, fresh ? "base" : "sync", signal, fresh);
      await save(repository, known);
      return { changed };
    },
    /**
     * Writes the repository's merged files back into the folder. Every target is checked first
     * and nothing is written when any of them changed since the last agreement.
     */
    async export(input: {
      folder: string;
      repository: string;
      signal: AbortSignal;
      assertAuthorized(): void;
    }) {
      const { folder, repository, signal } = input;
      if (!isManagedFolderRepository(folder, repository))
        throw new ManagedFolderError("managed_folder_unsafe");
      const known = await manifest(repository);
      const merged = await walk(repository, [], signal);
      const writes: string[] = [],
        removals: string[] = [],
        conflicts: string[] = [];
      for (const [path, file] of merged) {
        const expected = known.files[path];
        if (expected === file.hash) continue;
        const current = await fileHash(inside(folder, path));
        if (current === file.hash) known.files[path] = file.hash;
        else if (current === expected) writes.push(path);
        else conflicts.push(path);
      }
      for (const [path, hash] of Object.entries(known.files)) {
        if (merged.has(path)) continue;
        const current = await fileHash(inside(folder, path));
        if (current === undefined) delete known.files[path];
        else if (current === hash) removals.push(path);
        else conflicts.push(path);
      }
      if (conflicts.length) return { written: [], removed: [], conflicts };
      input.assertAuthorized();
      for (const path of writes) {
        signal.throwIfAborted();
        const target = inside(folder, path);
        await realParents(folder, target);
        await writeFile(target, await readFile(inside(repository, path)));
        known.files[path] = merged.get(path)?.hash as string;
      }
      for (const path of removals) {
        signal.throwIfAborted();
        await unlink(inside(folder, path));
        delete known.files[path];
      }
      await save(repository, known);
      return { written: writes, removed: removals, conflicts };
    },
    /** Undoes a merge whose write-back was refused, so the repository never runs ahead. */
    async rewind(input: { folder: string; repository: string; head: string; signal: AbortSignal }) {
      if (
        !isManagedFolderRepository(input.folder, input.repository) ||
        !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(input.head)
      )
        throw new ManagedFolderError("managed_folder_unsafe");
      await git(input.repository, ["reset", "-q", "--hard", input.head], input.signal);
    },
    /** Removes the whole repository; its container goes too once empty. */
    async remove(input: { folder: string; repository: string }) {
      if (!isManagedFolderRepository(input.folder, input.repository))
        throw new ManagedFolderError("managed_folder_unsafe");
      const info = await lstat(input.repository).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!info) return;
      if (!info.isDirectory()) throw new ManagedFolderError("managed_folder_unsafe");
      await rm(input.repository, { recursive: true, force: true, maxRetries: 3 });
      await rmdir(dirname(input.repository)).catch(() => {
        // Another plan's repository still lives in the container; it stays.
      });
    },
  };
  return {
    sync: (input: Parameters<typeof ops.sync>[0]) =>
      serial(input.repository, () => ops.sync(input)),
    export: (input: Parameters<typeof ops.export>[0]) =>
      serial(input.repository, () => ops.export(input)),
    rewind: (input: Parameters<typeof ops.rewind>[0]) =>
      serial(input.repository, () => ops.rewind(input)),
    remove: (input: Parameters<typeof ops.remove>[0]) =>
      serial(input.repository, () => ops.remove(input)),
  };
}
export type ManagedFolders = ReturnType<typeof createManagedFolders>;
