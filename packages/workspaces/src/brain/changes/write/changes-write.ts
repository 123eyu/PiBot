import { lstat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type GitWriteOperation, validGitIdentity } from "@pibot/execution";
import { containsPath } from "@pibot/policy";
import type { MethodParams } from "@pibot/workspaces-contract/full";
import { resolveRunWorkplace } from "../../runtime.ts";
import { type ChangesScope, changesError, writeMode } from "../changes-scope.ts";
import type { ChangesService } from "../changes-service.ts";
import { parseDiff, parseStatus, type StatusEntry } from "../git/changes-git.ts";
import { probeRepo, read, readIdentity, repoOperation } from "../git/changes-repo.ts";
import { executeWrite } from "./changes-write-run.ts";

/**
 * One fixed placeholder for every Bot. The reserved `.invalid` TLD (RFC 2606) can never
 * be a real mailbox, yet the `Name <email>` form is what GitHub and Git tools parse as a co-author.
 */
export const CO_AUTHOR_EMAIL = "pibot-bot@users.noreply.invalid";

/** A Bot name made safe for one trailer line: no line breaks, brackets or control characters. */
export function coAuthorTrailer(botName: string) {
  const name =
    botName
      .replace(/[\p{Cc}\p{Zl}\p{Zp}<>]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100)
      .trim() || "Pi Bot";
  return `Co-authored-by: ${name} <${CO_AUTHOR_EMAIL}>`;
}

/**
 * User-initiated Git writes: only the primary folder when it holds its own .git,
 * refused while a Bot run may write the same folder; sandboxed on macOS / Linux and run with the
 * hardened direct runner on Windows.
 */
export async function prepare(service: ChangesService, scope: ChangesScope, signal: AbortSignal) {
  const root = scope.root;
  if (root.role === "readonly") throw changesError("changes_readonly_root");
  const probe = await probeRepo(service.reader, root.path, service.platform, signal);
  if (probe.state !== "repo") throw changesError("changes_not_repo");
  // The repository's .git is above the folder, outside the write boundary.
  if (probe.info.subdirectory) throw changesError("changes_repo_above_folder");
  if (
    scope.nestedReadonly ||
    (!probe.info.layoutOk && !(await service.managedLayout?.allows(scope, signal)))
  )
    throw changesError("changes_readonly_root");
  if (await repoOperation(probe.info.gitDir)) throw changesError("changes_operation_in_progress");
  const mode = writeMode(service.platform, await service.local.target.isolationStatus(signal));
  if (!mode) throw changesError("changes_isolation_unavailable");
  for (const context of service.turn.running()) {
    // A run whose folder cannot be resolved right now is treated as possibly writing here.
    const writeRoots = await resolveRunWorkplace(service.local, context, signal).then(
      (place) => place.boundary.writeRoots,
      () => undefined,
    );
    if (
      !writeRoots ||
      writeRoots.some(
        (path) =>
          containsPath(path, root.path, service.platform) ||
          containsPath(root.path, path, service.platform),
      )
    )
      throw changesError("changes_busy");
  }
  const program = await service.reader.program();
  if (!program) throw changesError("changes_git_unavailable");
  return { info: probe.info, program, mode };
}

async function freshStatus(service: ChangesService, root: string, signal: AbortSignal) {
  const result = await read(() =>
    service.reader.run({ op: "status" }, { cwd: root, signal, maxBytes: 32 * 1024 * 1024 }),
  );
  if (result.overflow || result.exitCode !== 0) throw changesError("changes_stale");
  // Writes are refused for subdirectories in prepare(), so paths here are repository-relative.
  const parsed = parseStatus(result.stdout);
  service.remember(root, parsed.entries);
  return parsed;
}

export async function discard(
  service: ChangesService,
  params: MethodParams["changes.discard"],
  signal: AbortSignal,
) {
  const scope = await service.scope(params, signal);
  const { info, program, mode } = await prepare(service, scope, signal);
  const root = scope.root.path;
  const entry = (await freshStatus(service, root, signal)).entries.find(
    (candidate) => candidate.path === params.path,
  );
  if (!entry || entry.status === "conflicted") throw changesError("changes_stale");
  const facts = { path: params.path, target: params.hunk ? "hunk" : "file" };
  const write = { action: "changes.discard" as const, mode, program, facts };
  if (params.hunk) {
    if (!entry.inHead || entry.status !== "modified")
      throw changesError("changes_hunk_unsupported");
    const head = await read(() => service.reader.run({ op: "head" }, { cwd: root, signal }));
    const base = head.exitCode === 0 ? head.stdout.toString("utf8").trim() : info.emptyTree;
    const diff = await read(() =>
      service.reader.run(
        { op: "diff", base, path: params.path },
        { cwd: root, signal, maxBytes: 1024 * 1024 },
      ),
    );
    if (diff.overflow || diff.exitCode !== 0) throw changesError("changes_hunk_unsupported");
    const parsed = parseDiff(diff.stdout.toString("utf8"));
    const hunk = parsed.hunks[params.hunk.index];
    if (parsed.binary) throw changesError("changes_hunk_unsupported");
    if (!hunk || hunk.digest !== params.hunk.digest) throw changesError("changes_stale");
    const patch = `${[...parsed.header, hunk.header, ...hunk.lines].join("\n")}\n`;
    await executeWrite(
      service,
      scope,
      { ...write, operations: [{ kind: "applyReverse", patchFile: "patch" }], files: { patch } },
      signal,
    );
    return { ok: true as const };
  }
  await executeWrite(
    service,
    scope,
    { ...write, operations: [await discardOperation(service, root, entry)], files: {} },
    signal,
  );
  return { ok: true as const };
}

async function discardOperation(
  service: ChangesService,
  root: string,
  entry: StatusEntry,
): Promise<GitWriteOperation> {
  if (entry.status === "untracked") {
    const absolute = join(root, ...entry.path.split("/"));
    const info = await lstat(absolute).catch(() => undefined);
    if (
      !info ||
      info.isDirectory() ||
      !containsPath(root, await realpath(dirname(absolute)), service.platform)
    )
      throw changesError("changes_stale");
    return { kind: "deleteUntracked", absolutePath: absolute };
  }
  // Discarding a new file deletes it; anything in HEAD is restored from HEAD.
  return entry.inHead
    ? { kind: "restore", path: entry.path }
    : { kind: "remove", path: entry.path };
}

export async function commit(
  service: ChangesService,
  params: MethodParams["changes.commit"],
  signal: AbortSignal,
) {
  const scope = await service.scope(params, signal);
  const { program, mode } = await prepare(service, scope, signal);
  const root = scope.root.path;
  const paths = [...new Set(params.paths)];
  const entries = new Map(
    (await freshStatus(service, root, signal)).entries.map((entry) => [entry.path, entry]),
  );
  if (paths.some((path) => !entries.has(path) || entries.get(path)?.status === "conflicted"))
    throw changesError("changes_stale");
  const author = params.author ?? (await readIdentity(service.reader, root, signal));
  if (!author || !validGitIdentity(author.name, author.email))
    throw changesError("changes_author_missing");
  // The Bot is credited as a co-author; the user's own identity stays the author.
  const message = `${params.message.trim()}\n\n${coAuthorTrailer(scope.botName)}\n`;
  await executeWrite(
    service,
    scope,
    {
      action: "changes.commit",
      mode,
      program,
      operations: [
        {
          kind: "commit",
          pathspecFile: "paths",
          messageFile: "message",
          name: author.name,
          email: author.email,
        },
      ],
      files: { paths: `${paths.join("\0")}\0`, message },
      // The count is data; the 记录 page words it in the app's language (changesOperation).
      facts: { target: "commit", fileCount: paths.length },
    },
    signal,
  );
  const head = await read(() => service.reader.run({ op: "head" }, { cwd: root, signal }));
  const oid = head.stdout.toString("utf8").trim();
  if (head.exitCode !== 0 || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(oid))
    throw changesError("changes_write_failed");
  return { commit: oid };
}
