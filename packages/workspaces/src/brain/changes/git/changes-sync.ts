import { gitNetworkBranch, gitTemporaryRef } from "@pibot/execution";
import type { ChangesErrorCode, MethodParams } from "@pibot/workspaces-contract/full";
import { changesError } from "../changes-scope.ts";
import type { ChangesService } from "../changes-service.ts";
import { prepare } from "../write/changes-write.ts";
import { executeWrite } from "../write/changes-write-run.ts";
import { remoteSnapshot } from "./changes-remotes.ts";

export function syncFailure(output: string): ChangesErrorCode {
  if (
    /authentication failed|could not read Username|terminal prompts disabled|401|403|access denied/i.test(
      output,
    )
  )
    return "changes_remote_auth";
  if (/non-fast-forward|fetch first|rejected/i.test(output)) return "changes_remote_rejected";
  if (/not possible to fast-forward|divergent branches|refusing to merge/i.test(output))
    return "changes_remote_diverged";
  return "changes_remote_network";
}
/** A user click authorizes one current branch/remote, never arbitrary commands or a saved grant. */
export async function syncRemote(
  service: ChangesService,
  params: MethodParams["changes.sync"],
  signal: AbortSignal,
) {
  if (service.platform === "win32") throw changesError("changes_remote_unsupported");
  try {
    gitNetworkBranch(params.branch);
    gitNetworkBranch(params.remoteBranch);
  } catch {
    throw changesError("changes_remote_unsupported");
  }
  const scope = await service.scope(params, signal),
    prepared = await prepare(service, scope, signal);
  const initial = await remoteSnapshot(service, scope, signal);
  const remote = initial.remotes.find((entry) => entry.name === params.remote);
  const url = params.action === "push" ? remote?.push : remote?.fetch;
  if (!url) throw changesError("changes_remote_unsupported");
  if (
    params.action === "pull" &&
    (!initial.upstream ||
      initial.upstream.remote !== params.remote ||
      initial.upstream.branch !== params.remoteBranch)
  )
    throw changesError("changes_remote_no_upstream");
  const permission = async (bound: AbortSignal) => {
    const local = service.local,
      policy = await local.getPolicy(bound);
    const settings = scope.groupId
      ? local.permissions.effectiveGroup(scope.groupId)
      : local.permissions.effective(scope.botId);
    const result = await policy.evaluate({
      botId: scope.botId,
      request: { category: "web", url: url.href },
      settings,
      permissionSources: local.permissions.sources(scope.botId, scope.groupId),
      workplace: {
        home: scope.home,
        currentId: "home",
        folders: scope.roots.map((root) => ({ id: root.id, name: root.name, path: root.path })),
      },
      cwd: scope.primary.path,
      signal: bound,
    });
    if (result.decision === "deny") throw changesError("changes_remote_policy");
  };
  await permission(signal);
  await executeWrite(
    service,
    scope,
    {
      action: "changes.sync",
      mode: prepared.mode,
      program: prepared.program,
      operations: [
        {
          kind: "sync",
          action: params.action,
          url: url.href,
          branch: params.remoteBranch,
          head: params.head,
          temporaryRef: gitTemporaryRef(),
          filters: initial.filters,
        },
      ],
      files: {},
      facts: { target: `${params.action}:${params.remote}` },
      failure: syncFailure,
      verify: async (bound) => {
        const freshScope = await service.scope(params, bound),
          freshPrepared = await prepare(service, freshScope, bound),
          fresh = await remoteSnapshot(service, freshScope, bound);
        if (
          fresh.head !== params.head ||
          fresh.branch !== params.branch ||
          freshPrepared.info.gitDir !== prepared.info.gitDir ||
          fresh.scope.conversationId !== scope.conversationId ||
          (params.action === "push"
            ? fresh.remotes.find((entry) => entry.name === params.remote)?.push?.href
            : fresh.remotes.find((entry) => entry.name === params.remote)?.fetch?.href) !==
            url.href ||
          JSON.stringify(fresh.filters) !== JSON.stringify(initial.filters)
        )
          throw changesError("changes_stale");
        if (fresh.dirty) throw changesError("changes_remote_dirty");
        if (
          params.action === "pull" &&
          JSON.stringify(fresh.upstream) !== JSON.stringify(initial.upstream)
        )
          throw changesError("changes_stale");
        await permission(bound);
      },
    },
    signal,
  );
  return { ok: true as const };
}
