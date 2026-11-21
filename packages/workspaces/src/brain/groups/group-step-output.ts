import { createHash } from "node:crypto";
import { lstat, mkdir, opendir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceLocal as LocalService } from "@pibot/brain/kit";
import { RpcError, type WorkspaceSnapshot } from "@pibot/workspaces-contract/full";
import { z } from "zod";

/**
 * A plan's output folder (`<primary>/.pibot/out/...`) is outside Git: `.pibot` is excluded in
 * every managed repository, and a member's commit may never carry it. A step's workspace
 * therefore receives the folder's current files when it is created, and on merge the files the
 * step added or changed are written back. The seed digest makes a file someone else changed in
 * the meantime a conflict instead of a silent overwrite.
 */
const MAX_FILES = 200;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const SeedSchema = z.strictObject({
  relative: z.string().max(1000),
  files: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
});
type Seed = z.infer<typeof SeedSchema>;
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** File access on the machine the folders are on: this desktop's disk or the runner's. */
interface OutputDisk {
  readonly paths: typeof path.posix;
  list(root: string, signal: AbortSignal): Promise<string[]>;
  read(file: string, signal: AbortSignal): Promise<Buffer | undefined>;
  write(file: string, data: Buffer, replace: boolean, signal: AbortSignal): Promise<void>;
}

const localDisk: OutputDisk = {
  paths: path,
  async list(root, signal) {
    const files: string[] = [];
    const visit = async (directory: string) => {
      let handle: Awaited<ReturnType<typeof opendir>>;
      try {
        handle = await opendir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for await (const entry of handle) {
        signal.throwIfAborted();
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(file);
        else if (entry.isFile()) files.push(path.relative(root, file).split(path.sep).join("/"));
        if (files.length > MAX_FILES) throw new RpcError(-32602, "group_step_output_too_large");
      }
    };
    await visit(root);
    return files;
  },
  async read(file) {
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.nlink !== 1) return Buffer.from("\0foreign");
      if (info.size > MAX_FILE_BYTES) throw new RpcError(-32602, "group_step_output_too_large");
      return await readFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  },
  async write(file, data, replace) {
    // Parents of an output file are real directories created here; a link is refused below.
    await mkdir(path.dirname(file), { recursive: true });
    const parent = await lstat(path.dirname(file));
    if (!parent.isDirectory()) throw new RpcError(-32602, "group_step_output_unsafe");
    await writeFile(file, data, { flag: replace ? "w" : "wx" });
  },
};

function remoteDisk(local: LocalService, boundary: WorkspaceSnapshot): OutputDisk {
  const files = local.runtime.files(boundary);
  const paths = boundary.location?.platform === "win32" ? path.win32 : path.posix;
  const root = boundary.primaryPath;
  return {
    paths,
    async list(base, signal) {
      const found: string[] = [];
      const visit = async (directory: string, prefix: string) => {
        const entries = await files.entries(directory, signal).catch((error: unknown) => {
          signal.throwIfAborted();
          if (prefix) throw error;
          return []; // A folder the step never created has nothing to carry.
        });
        for (const entry of entries) {
          const name = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.kind === "directory") await visit(paths.join(directory, entry.name), name);
          else if (entry.kind === "file") found.push(name);
          if (found.length > MAX_FILES) throw new RpcError(-32602, "group_step_output_too_large");
        }
      };
      await visit(base, "");
      return found;
    },
    async read(file, signal) {
      const result = await files.read(root, file, signal, MAX_FILE_BYTES).catch(() => {
        signal.throwIfAborted();
        return undefined;
      });
      if (result && !result.data) throw new RpcError(-32602, "group_step_output_too_large");
      return result?.data;
    },
    async write(file, data, replace, signal) {
      // The runner's file plane only creates files; replacing one there is left to a person.
      if (replace) throw new RpcError(-32602, "group_step_output_conflict");
      await files.create(file, data, signal);
    },
  };
}

function seedFile(local: LocalService, taskId: string) {
  return path.join(local.deps.dataDir, "group-step-seeds", `${taskId}.json`);
}
function disk(local: LocalService, boundary: WorkspaceSnapshot) {
  return boundary.location && boundary.location.target !== "local"
    ? remoteDisk(local, boundary)
    : localDisk;
}
function join(paths: typeof path.posix, root: string, relative: string, file = "") {
  const target = paths.resolve(root, relative, ...file.split("/").filter(Boolean));
  if (!target.startsWith(`${root}${paths.sep}`))
    throw new RpcError(-32602, "group_step_output_unsafe");
  return target;
}

/** Copies the output folder into a fresh step workspace and remembers what it started from. */
export async function seedStepOutput(
  local: LocalService,
  boundary: WorkspaceSnapshot,
  input: { taskId: string; primary: string; outputFolder: string; workspace: string },
  signal: AbortSignal,
) {
  const io = disk(local, boundary);
  const relative = io.paths.relative(input.primary, input.outputFolder);
  if (!relative || relative.startsWith("..") || io.paths.isAbsolute(relative))
    throw new RpcError(-32602, "group_step_output_unsafe");
  const source = join(io.paths, input.primary, relative);
  const seed: Seed = { relative, files: {} };
  for (const file of await io.list(source, signal)) {
    const data = await io.read(join(io.paths, input.primary, relative, file), signal);
    if (!data) continue;
    seed.files[file] = digest(data);
    const target = join(io.paths, input.workspace, relative, file);
    if (!(await io.read(target, signal))) await io.write(target, data, false, signal);
  }
  await mkdir(path.dirname(seedFile(local, input.taskId)), { recursive: true, mode: 0o700 });
  await writeFile(seedFile(local, input.taskId), JSON.stringify(seed), { mode: 0o600 });
}

/** Whether this task's workspace belongs to a plan step (and so is merged by the program). */
export async function isPlanStepWorkspace(local: LocalService, taskId: string) {
  return (await lstat(seedFile(local, taskId)).catch(() => undefined)) !== undefined;
}

export interface OutputWrite {
  target: string;
  data: Buffer;
  replace: boolean;
}
/**
 * What the step added or changed in its output folder, checked against the real folder now.
 * Conflicts name the files relative to the output folder; nothing has been written yet.
 */
export async function stepOutputChanges(
  local: LocalService,
  boundary: WorkspaceSnapshot,
  input: { taskId: string; primary: string; workspace: string },
  signal: AbortSignal,
) {
  const seed = SeedSchema.parse(JSON.parse(await readFile(seedFile(local, input.taskId), "utf8")));
  const io = disk(local, boundary);
  const writes: OutputWrite[] = [],
    conflicts: string[] = [];
  const base = join(io.paths, input.workspace, seed.relative);
  for (const file of await io.list(base, signal)) {
    const data = await io.read(join(io.paths, input.workspace, seed.relative, file), signal);
    if (!data) continue;
    const hash = digest(data);
    const started = seed.files[file];
    if (hash === started) continue;
    const target = join(io.paths, input.primary, seed.relative, file);
    const current = await io.read(target, signal);
    const now = current ? digest(current) : undefined;
    if (now === hash) continue;
    if (now !== started) conflicts.push(`${seed.relative}/${file}`.split("\\").join("/"));
    else writes.push({ target, data, replace: current !== undefined });
  }
  return { writes, conflicts, io };
}

export async function writeStepOutput(
  changes: Awaited<ReturnType<typeof stepOutputChanges>>,
  signal: AbortSignal,
) {
  for (const write of changes.writes) {
    signal.throwIfAborted();
    await changes.io.write(write.target, write.data, write.replace, signal);
  }
}

export async function forgetStepOutput(local: LocalService, taskId: string) {
  await rm(seedFile(local, taskId), { force: true });
}
