import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { WorkspaceLocal as LocalService } from "@pibot/brain/kit";
import {
  createGitReader,
  type ManagedGit,
  type ManagedGitAuthority,
  type ManagedGitRepository,
} from "@pibot/execution";
import { containsPath } from "@pibot/policy";
import { RpcError } from "@pibot/workspaces-contract/full";
import { parseStatus } from "../changes/git/changes-git.ts";

/** Files a member's commit must never carry, local or on a runner (Git paths use `/`). */
export function sensitiveOutputPath(path: string) {
  return path
    .split("/")
    .some(
      (part) =>
        ["..", ".git", ".pibot", ".ssh", ".aws", ".gnupg"].includes(part) ||
        part === ".env" ||
        part.startsWith(".env.") ||
        /\.(?:pem|p12|pfx|key)$/i.test(part),
    );
}

/** A fresh isolated tree contains this member's outputs, never a shared staging area. */
export async function commitGroupWorktree(
  local: LocalService,
  git: ManagedGit,
  repository: ManagedGitRepository,
  authority: ManagedGitAuthority,
) {
  if (repository.clean) return repository;
  const reader = createGitReader({
    platform: local.deps.platform,
    env: local.deps.env,
    userHome: local.deps.userHome,
    resourcesDir: local.deps.resourcesDir,
  });
  // The fixed recipe reads these files inside its sandbox, which reads the Bot home but not the
  // system temp folder (the same place changes-write keeps its pathspec and message files).
  const directory = join(authority.home, ".pibot", "group-commits", randomUUID());
  try {
    const result = await reader.run(
      { op: "status" },
      { cwd: repository.root.path, signal: authority.signal, maxBytes: 1024 * 1024 },
    );
    if (result.exitCode !== 0 || result.overflow)
      throw new RpcError(-32602, "group_workspace_commit_unavailable");
    const parsed = parseStatus(result.stdout);
    if (parsed.entries.some((e) => e.status === "conflicted"))
      throw new RpcError(-32602, "group_workspace_commit_unavailable");
    const paths = new Set(parsed.entries.map((e) => e.path));
    const tokens = result.stdout.toString("utf8").split("\0");
    for (let i = 0; i < tokens.length; i++)
      if (tokens[i]?.startsWith("2 ")) {
        const original = tokens[++i];
        if (original) paths.add(original);
      }
    if (!paths.size || paths.size > 500)
      throw new RpcError(-32602, "group_workspace_commit_unavailable");
    let bytes = 0;
    for (const path of paths) {
      authority.signal.throwIfAborted();
      if (sensitiveOutputPath(path)) throw new RpcError(-32602, "group_workspace_sensitive_output");
      const absolute = resolve(repository.root.path, path);
      // A native resolve() result: a `/` prefix test refused every Windows commit with changes.
      if (
        absolute === repository.root.path ||
        !containsPath(repository.root.path, absolute, local.deps.platform)
      )
        throw new RpcError(-32602, "group_workspace_sensitive_output");
      try {
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) continue;
        if (!info.isFile() || info.nlink !== 1 || info.size > 5 * 1024 * 1024)
          throw new RpcError(-32602, "group_workspace_commit_unavailable");
        bytes += info.size;
        if (bytes > 32 * 1024 * 1024)
          throw new RpcError(-32602, "group_workspace_commit_unavailable");
        if ((await realpath(absolute)) !== absolute)
          throw new RpcError(-32602, "group_workspace_sensitive_output");
        const content = await readFile(absolute);
        const text = content.toString("utf8");
        if (local.deps.redactor.redact(text) !== text)
          throw new RpcError(-32602, "group_workspace_sensitive_output");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const pathspec = join(directory, "paths"),
      message = join(directory, "message");
    await writeFile(pathspec, `${[...paths].join("\0")}\0`, { mode: 0o600 });
    await writeFile(message, "chore: integrate group member task outputs\n", { mode: 0o600 });
    await git.writeChanges(
      repository,
      [
        {
          kind: "commit",
          pathspecFile: pathspec,
          messageFile: message,
          name: "Pi Bot",
          email: "pibot@localhost",
        },
      ],
      authority,
    );
    return await git.inspect(repository.root.path, authority.signal);
  } finally {
    reader.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}
