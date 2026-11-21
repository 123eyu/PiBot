import { gitNetworkBranch, gitNetworkURL } from "@pibot/execution";
import type { MethodParams } from "@pibot/workspaces-contract/full";
import { type ChangesScope, changesError } from "../changes-scope.ts";
import type { ChangesService } from "../changes-service.ts";
import { parseStatus } from "./changes-git.ts";
import { notRepoError, probeRepo, read } from "./changes-repo.ts";

export async function remoteSnapshot(
  service: ChangesService,
  scope: ChangesScope,
  signal: AbortSignal,
) {
  const probe = await probeRepo(service.reader, scope.root.path, service.platform, signal);
  if (probe.state !== "repo") throw notRepoError(probe);
  const run = (operation: Parameters<typeof service.reader.run>[0]) =>
    read(() =>
      service.reader.run(operation, { cwd: scope.root.path, signal, maxBytes: 256 * 1024 }),
    );
  const [names, status, head, config] = await Promise.all([
    run({ op: "remoteNames" }),
    run({ op: "status", includeSubmodules: true }),
    run({ op: "head" }),
    run({ op: "networkConfig" }),
  ]);
  if (
    [names, status, head, config].some((value) => value.overflow) ||
    names.exitCode !== 0 ||
    status.exitCode !== 0 ||
    (config.exitCode !== 0 && config.exitCode !== 1)
  )
    throw changesError("changes_remote_unavailable");
  const parsed = parseStatus(status.stdout),
    branch = parsed.branch;
  const keys = config.stdout.toString("utf8").split("\0").filter(Boolean);
  const unsafe = keys.some(
    (key) => /^url\./i.test(key) || /^http\..+\./i.test(key) || /^http\.proxy$/i.test(key),
  );
  const filters = [
    ...new Set(
      keys.flatMap(
        (key) => /^filter\.(.+)\.(?:clean|smudge|process|required)$/i.exec(key)?.[1] ?? [],
      ),
    ),
  ];
  if (filters.length > 128 || filters.some((name) => !/^[A-Za-z0-9_.-]{1,200}$/.test(name)))
    throw changesError("changes_remote_unsupported");
  const remoteNames = names.stdout.toString("utf8").split("\n").filter(Boolean);
  if (remoteNames.length > 50) throw changesError("changes_remote_unavailable");
  const remotes = [];
  for (const name of remoteNames) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(name)) continue;
    const urls = await Promise.all([
      run({ op: "remoteURL", remote: name }),
      run({ op: "remoteURL", remote: name, push: true }),
    ]);
    const safe = (result: (typeof urls)[number]) => {
      const values = result.stdout.toString("utf8").trimEnd().split("\n");
      if (result.exitCode !== 0 || result.overflow || values.length !== 1 || unsafe)
        return undefined;
      try {
        return gitNetworkURL(values[0] as string);
      } catch {
        return undefined;
      }
    };
    remotes.push({ name, fetch: safe(urls[0]), push: safe(urls[1]) });
  }
  let upstream: { remote: string; branch: string } | null = null;
  if (branch) {
    let portable = true;
    try {
      gitNetworkBranch(branch);
    } catch {
      portable = false;
    }
    if (portable) {
      const tracking = await run({ op: "tracking", branch });
      if (tracking.exitCode !== 0 || tracking.overflow)
        throw changesError("changes_remote_unavailable");
      const [remote, ref] = tracking.stdout.toString("utf8").trimEnd().split("\0");
      if (remote && ref?.startsWith("refs/heads/")) {
        try {
          upstream = { remote, branch: gitNetworkBranch(ref.slice("refs/heads/".length)) };
        } catch {
          /* Unsupported upstream syntax stays unavailable; it never becomes argv. */
        }
      }
    }
  }
  const oid = head.stdout.toString("utf8").trim();
  return {
    scope,
    probe,
    head: head.exitCode === 0 && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(oid) ? oid : null,
    branch,
    upstream,
    remotes,
    filters,
    dirty: parsed.entries.length > 0,
  };
}
export async function listRemotes(
  service: ChangesService,
  params: MethodParams["changes.remotes"],
  signal: AbortSignal,
) {
  const scope = await service.scope(params, signal),
    snapshot = await remoteSnapshot(service, scope, signal);
  const writable =
    service.platform !== "win32" &&
    scope.root.role === "primary" &&
    scope.root.id === scope.primary.id &&
    !scope.nestedReadonly &&
    (snapshot.probe.info.layoutOk || !!(await service.managedLayout?.allows(scope, signal)));
  return {
    head: snapshot.head,
    branch: snapshot.branch,
    upstream: snapshot.upstream,
    writable,
    remotes: snapshot.remotes.map((remote) => ({
      name: remote.name,
      fetchHost: remote.fetch?.hostname ?? null,
      pushHost: remote.push?.hostname ?? null,
      fetchSupported: !!remote.fetch,
      pushSupported: !!remote.push,
    })),
  };
}
