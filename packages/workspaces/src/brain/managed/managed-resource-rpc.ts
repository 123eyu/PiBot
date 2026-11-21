import type { RegisterRpc } from "@pibot/brain/kit";
import type { ManagedResources } from "./managed-resources.ts";

/** User actions only, registered through the existing validated/redacted RPC wrapper. */
export function registerManagedResourceRpc(handle: RegisterRpc, resources: ManagedResources) {
  const { worktrees, checkpoints, run } = resources;
  handle("worktrees.views", (input) =>
    run(input.target, (signal) => resources.scm.list(input, signal)),
  );
  handle("worktrees.review", (input) =>
    run(input.target, (signal) => resources.scm.review(input, signal)),
  );
  handle("groups.tasks.worktree.integrate", (input) =>
    run({ conversationKey: `group:${input.groupId}` }, (signal) =>
      resources.groupTaskWorktrees.integrate(input, signal),
    ),
  );
  handle("groups.tasks.worktree.remove", (input) =>
    run({ conversationKey: `group:${input.groupId}` }, (signal) =>
      resources.groupTaskWorktrees.remove(input, signal),
    ),
  );
  handle("worktrees.allocate", ({ target }) => resources.allocate(target));
  handle("worktrees.list", ({ target, limit, before }) =>
    run(target, (signal) => worktrees.list(target, limit, before, signal)),
  );
  handle("worktrees.create", (input) =>
    run(input.target, (signal) => worktrees.create(input, signal)),
  );
  handle("worktrees.bind", (input) => run(input.target, (signal) => worktrees.bind(input, signal)));
  handle("worktrees.integrate", (input) =>
    run(input.target, (signal) => worktrees.integrate(input, signal)),
  );
  handle("worktrees.remove", (input) =>
    run(input.target, (signal) => worktrees.remove(input, signal)),
  );
  handle("worktrees.recover", ({ target, id }) =>
    run(target, (signal) => worktrees.recover(target, id, signal)),
  );
  handle("changes.checkpoints.forRun", ({ target, runId }, { signal: request }) =>
    run(target, (signal) => checkpoints.forRun(target, runId, AbortSignal.any([signal, request]))),
  );
  handle("changes.checkpoints.create", ({ target, runId }) =>
    run(target, (signal) => checkpoints.create(target, runId, signal)),
  );
  handle("changes.checkpoints.list", ({ target, limit, before }) =>
    run(target, (signal) => checkpoints.list(target, limit, before, signal)),
  );
  handle("changes.checkpoints.get", ({ target, id }) =>
    run(target, (signal) => checkpoints.get(target, id, signal)),
  );
  handle("changes.checkpoints.restore", (input) =>
    run(input.target, (signal) => checkpoints.restore(input, signal)),
  );
  handle("changes.checkpoints.restores", ({ target, id, limit, before }) =>
    run(target, (signal) => checkpoints.restores(target, id, limit, before, signal)),
  );
  handle("changes.checkpoints.resume", ({ target, restoreId }) =>
    run(target, (signal) => checkpoints.resume(target, restoreId, signal)),
  );
  handle("changes.checkpoints.recover", ({ target, restoreId }) =>
    run(target, (signal) => checkpoints.recover(target, restoreId, signal)),
  );
}
