import { containsPath } from "@pibot/policy";
import { watchTree } from "@pibot/scheduler";
import type { ChangesService } from "./changes-service.ts";
import { probeRepo } from "./git/changes-repo.ts";

/** Keep parent directories observable on Linux; pruning refs also prunes branch updates. */
export function gitMetadataIgnored(path: string) {
  return !(
    path === "." ||
    path === "refs" ||
    path === "refs/heads" ||
    /^(?:index|HEAD|packed-refs|MERGE_HEAD|REBASE_HEAD|CHERRY_PICK_HEAD|refs\/heads\/.+)$/.test(
      path,
    )
  );
}
export function changesWatchIgnored(path: string) {
  if (path.split("/").includes("node_modules")) return true;
  if (path === ".git") return false;
  return path.startsWith(".git/") && gitMetadataIgnored(path.slice(5));
}
/** Linked worktrees store HEAD and branch refs outside the visible working folder. */
export async function watchChanges(
  service: ChangesService,
  root: string,
  onChange: () => void,
  onError: () => void,
  signal: AbortSignal,
) {
  const probe = await probeRepo(service.reader, root, service.platform, signal);
  signal.throwIfAborted();
  const watches: ReturnType<typeof watchTree>[] = [];
  try {
    watches.push(
      watchTree({
        root,
        platform: service.platform,
        ignore: changesWatchIgnored,
        onChange,
        onError,
      }),
    );
    if (probe.state === "repo") {
      for (const metadata of new Set([probe.info.gitDir, probe.info.commonDir])) {
        if (containsPath(root, metadata, service.platform)) continue;
        watches.push(
          watchTree({
            root: metadata,
            platform: service.platform,
            ignore: gitMetadataIgnored,
            onChange,
            onError,
          }),
        );
      }
    }
    return {
      stop: async () => {
        await Promise.allSettled(watches.map((watch) => watch.stop()));
      },
    };
  } catch (error) {
    await Promise.allSettled(watches.map((watch) => watch.stop()));
    throw error;
  }
}
