import { useRuntime } from "../../../runtime/context.tsx";
import { readWorkplace } from "./calls.ts";
import { type ChatScope, isDm, scopeKey } from "./scope.ts";
import { useRemoteValue } from "./use-remote-value.ts";

/** A DM topic's primary folder; candidates are folders already associated on the computer. */
export function useWorkplace(scope: ChatScope | undefined) {
  const runtime = useRuntime();
  const enabled = !!scope && isDm(scope);
  const state = useRemoteValue(
    enabled ? `workplace:${scopeKey(scope)}` : undefined,
    (signal) => readWorkplace(runtime, scope as ChatScope, signal),
    ["changes.changed"],
  );
  const value = state.value;
  const current = value?.folders.find((folder) => folder.id === value.folderId);
  return {
    ...state,
    enabled,
    currentName: current?.name,
    /** Undefined until read; then whether the topic works in the Bot's own folder. */
    isHome: value ? value.folderId === "home" : undefined,
    runnerOffline: !!value?.runnerOffline,
    pickRunner: (location: string, path: string, readonly = false, parent?: AbortSignal) =>
      state.write.run(async (ownerSignal) => {
        const signal = parent ? AbortSignal.any([ownerSignal, parent]) : ownerSignal;
        signal.throwIfAborted();
        if (!scope || !enabled) return;
        const before = await runtime.call(
          "topics.workplace.get",
          { botId: scope.id, topicId: scope.topicId },
          signal,
        );
        const primary = before.workplace.folders.find((f) => f.id === before.folderId);
        if (readonly && primary?.location !== location) throw new Error("workspace_targets_mixed");
        const picked = await runtime.call(
          "workplaces.pick",
          { botId: scope.id, location, path },
          signal,
        );
        signal.throwIfAborted();
        if (!picked.folder) return;
        await runtime.call(
          "topics.workplace.update",
          {
            botId: scope.id,
            topicId: scope.topicId,
            selection: readonly
              ? {
                  primary: before.folderId ?? "home",
                  readonly: [...new Set([...(before.readonly ?? []), picked.folder.id])],
                  writable: before.writable ?? [],
                }
              : { primary: picked.folder.id, readonly: [], writable: [] },
          },
          signal,
        );
        signal.throwIfAborted();
        const next = await readWorkplace(runtime, scope, signal);
        signal.throwIfAborted();
        state.setValue(next);
        return true;
      }),
    choose: (folderId: string) =>
      state.write.run(async (signal) => {
        if (!scope) return;
        const before = await runtime.call(
          "topics.workplace.get",
          { botId: scope.id, topicId: scope.topicId },
          signal,
        );
        const location =
          before.workplace.folders.find((f) => f.id === folderId)?.location ?? "local";
        const same = (id: string) =>
          (before.workplace.folders.find((f) => f.id === id)?.location ?? "local") === location &&
          id !== folderId;
        await runtime.call(
          "topics.workplace.update",
          {
            botId: scope.id,
            topicId: scope.topicId,
            selection: {
              primary: folderId,
              readonly: (before.readonly ?? []).filter(same),
              writable: (before.writable ?? []).filter(same),
            },
          },
          signal,
        );
        signal.throwIfAborted();
        const next = await readWorkplace(runtime, scope, signal);
        signal.throwIfAborted();
        state.setValue(next);
        return true;
      }),
  };
}
