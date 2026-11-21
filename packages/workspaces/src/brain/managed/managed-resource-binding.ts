import type {
  WorkspaceGroups as GroupService,
  WorkspaceLocal as LocalService,
  WorkspaceTopics as TopicWorkplaceService,
} from "@pibot/brain/kit";
import type { ManagedRecord } from "@pibot/storage";
import type { ChangesScope } from "../changes/changes-scope.ts";
import type { ManagedResourceAuthority } from "./managed-resource-authority.ts";
import type { ManagedResourceLifecycle } from "./managed-resource-lifecycle.ts";
import { managedError } from "./managed-resource-ports.ts";

/** Reuses the real topic/group mutation transaction rather than keeping a second workspace model. */
export function managedBinding(
  local: LocalService,
  groups: GroupService,
  topics: TopicWorkplaceService,
  lifecycle: ManagedResourceLifecycle,
  authority: ManagedResourceAuthority,
) {
  return async (
    scope: ChangesScope,
    tree: ManagedRecord,
    recordReference: () => void,
    signal: AbortSignal,
    restoreSource = false,
  ) => {
    const path = restoreSource ? tree.sourcePath : tree.path;
    const permission = await authority.authorize(scope, "bind", [path], signal);
    await lifecycle.exclusive(
      scope,
      [scope.primary.path, tree.path, tree.sourcePath],
      signal,
      async () => {
        permission.assertAuthorized();
        if (scope.groupId) {
          await groups.folders.bindManaged(
            scope.groupId,
            path,
            permission.assertAuthorized,
            recordReference,
            { tree, restoreSource, signal },
          );
        } else {
          if (!scope.topicId) managedError("worktree_topic_required");
          const folder = local.workplaces.repo.register(scope.botId, path);
          const source = local.workplaces.repo.register(scope.botId, tree.sourcePath);
          const selection = local.workplaces.topic(scope.topicId).selection;
          const removed = restoreSource
            ? local.workplaces.repo.register(scope.botId, tree.path).id
            : folder.id;
          await topics.update(
            {
              botId: scope.botId,
              topicId: scope.topicId,
              selection: {
                primary: folder.id,
                readonly: [
                  ...new Set([...selection.readonly, ...(restoreSource ? [] : [source.id])]),
                ].filter((id) => id !== folder.id && id !== removed),
              },
            },
            { assertCurrent: permission.assertAuthorized, recordReference },
          );
        }
      },
    );
  };
}
