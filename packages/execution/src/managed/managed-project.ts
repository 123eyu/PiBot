import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import pathApi, { join } from "node:path";
import { sameFile } from "../core/file-identity.ts";
import { holdManagedPaths, type ManagedPathIdentity, managedIdentity } from "./managed-boundary.ts";
import { ManagedExecError } from "./managed-errors.ts";

const MAX_IGNORE_BYTES = 1024 * 1024;

/** `paths`: the worktree machine's rules; a runner on Windows is never named with macOS rules. */
export function managedWorktreePath(
  parent: string,
  project: string,
  id: string,
  paths: Pick<typeof pathApi, "basename" | "join"> = pathApi,
) {
  const name =
    Array.from(paths.basename(project).replace(/[\p{Cc}\p{Cf}<>:"/\\|?*]/gu, "-"))
      .slice(0, 80)
      .join("") || "project";
  return paths.join(parent, `${name}-${id}`);
}

async function directory(path: string, check: () => Promise<void>) {
  await check();
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await check();
  return managedIdentity(path);
}

/** Repository-local metadata only: tracked ignore files must stay byte-for-byte unchanged. */
async function ignoreContainer(path: string, check: () => Promise<void>) {
  await check();
  try {
    const existing = await lstat(path);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)
      throw new ManagedExecError("managed_exclude_unsafe");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const handle = await open(
    path,
    constants.O_RDWR |
      constants.O_APPEND |
      constants.O_CREAT |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
    0o644,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(MAX_IGNORE_BYTES))
      throw new ManagedExecError("managed_exclude_unsafe");
    const buffer = Buffer.alloc(Number(before.size));
    let read = 0;
    while (read < buffer.length) {
      await check();
      const result = await handle.read(buffer, read, buffer.length - read, read);
      if (!result.bytesRead) throw new ManagedExecError("managed_exclude_unsafe");
      read += result.bytesRead;
    }
    const current = await lstat(path, { bigint: true }),
      pinned = await handle.stat({ bigint: true });
    if (
      current.isSymbolicLink() ||
      !sameFile(current, before) ||
      pinned.nlink !== 1n ||
      pinned.size !== before.size ||
      pinned.mtimeNs !== before.mtimeNs
    )
      throw new ManagedExecError("managed_exclude_unsafe");
    const lines = buffer
      .toString("utf8")
      .split("\n")
      .map((line) => line.replace(/\r? *$/, ""));
    const rule = lines.lastIndexOf(".pibot");
    // A later negative pattern can re-include the container; the final rule must win.
    const negative = lines.findLastIndex((line) => line.startsWith("!"));
    if (rule >= 0 && rule > negative) return;
    await check();
    const eol = buffer.includes(Buffer.from("\r\n")) ? "\r\n" : "\n";
    const separator = buffer.length && buffer[buffer.length - 1] !== 10 ? eol : "";
    if (buffer.length + Buffer.byteLength(`${separator}.pibot${eol}`) > MAX_IGNORE_BYTES)
      throw new ManagedExecError("managed_exclude_unsafe");
    await handle.writeFile(`${separator}.pibot${eol}`);
    await handle.sync();
    await check();
    const after = await lstat(path, { bigint: true });
    if (!sameFile(after, before) || after.nlink !== 1n)
      throw new ManagedExecError("managed_exclude_unsafe");
  } finally {
    await handle.close();
  }
}

/** Core-issued project-local storage, held against pathname swaps for the whole setup. */
export async function prepareManagedProject(
  root: ManagedPathIdentity,
  signal: AbortSignal,
  authorize: () => void,
  expectedGit?: ManagedPathIdentity,
) {
  const git = expectedGit ?? (await managedIdentity(join(root.path, ".git")));
  if (git.path !== join(root.path, ".git"))
    throw new ManagedExecError("managed_git_layout_unsupported");
  const project = await holdManagedPaths([root, git], signal, authorize);
  try {
    const info = await directory(join(git.path, "info"), project.check);
    const heldInfo = await holdManagedPaths([root, git, info], signal, authorize);
    try {
      const container = await directory(join(root.path, ".pibot"), heldInfo.check);
      const heldContainer = await holdManagedPaths([root, git, info, container], signal, authorize);
      try {
        const parent = await directory(join(container.path, "wt"), heldContainer.check);
        const heldParent = await holdManagedPaths(
          [root, git, info, container, parent],
          signal,
          authorize,
        );
        try {
          await ignoreContainer(join(info.path, "exclude"), heldParent.check);
          await heldParent.check();
          return parent;
        } finally {
          await heldParent.close();
        }
      } finally {
        await heldContainer.close();
      }
    } finally {
      await heldInfo.close();
    }
  } finally {
    await project.close();
  }
}
