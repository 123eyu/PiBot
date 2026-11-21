import type { AcpFolderStaging, AcpRpcPort } from "./runtime-rpc.ts";
import type { AcpRuntimePort } from "./types.ts";

export function groupRuntime(options: {
  rpc: AcpRpcPort;
  folders: AcpFolderStaging;
  ready(signal: AbortSignal): Promise<void>;
  timeoutMs: number;
}): Pick<
  AcpRuntimePort,
  | "groups"
  | "group"
  | "createGroupTopic"
  | "rebindGroupTopic"
  | "attachGroupTopic"
  | "archiveGroupTopic"
  | "sendGroupPrompt"
  | "groupSnapshot"
  | "cancelGroup"
> {
  const bounded = (signal: AbortSignal) =>
    AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]);
  const pick = async (
    input: { groupId: string; cwd: string; additionalDirectories: string[] },
    signal: AbortSignal,
  ) => {
    const ids = [];
    for (const path of new Set([input.cwd, ...input.additionalDirectories])) {
      signal.throwIfAborted();
      const choice = await options.folders.withPath(
        path,
        () =>
          options.rpc.call(
            "groups.topics.pickFolder",
            { groupId: input.groupId },
            { signal: bounded(signal) },
          ),
        bounded(signal),
      );
      if (!choice) throw new Error("ACP group working directory was not registered");
      ids.push(choice.choiceId);
    }
    if (!ids[0]) throw new Error("ACP group working directory is missing");
    return { primary: ids[0], readonly: ids.slice(1) };
  };
  return {
    async groups(signal) {
      await options.ready(signal);
      return options.rpc.call("groups.acp.list", {}, { signal: bounded(signal) });
    },
    async group(groupId, signal) {
      await options.ready(signal);
      return options.rpc.call("groups.acp.get", { groupId }, { signal: bounded(signal) });
    },
    async createGroupTopic(input, signal) {
      await options.ready(signal);
      const selection = await pick(input, signal);
      const topic = await options.rpc.call(
        "groups.acp.topics.create",
        { groupId: input.groupId, selection },
        { signal: bounded(signal) },
      );
      try {
        if (input.yolo)
          await options.rpc.call(
            "conversations.yolo.set",
            { conversationId: topic.topicId, enabled: true },
            { signal: bounded(signal) },
          );
        signal.throwIfAborted();
        return topic;
      } catch (error) {
        await options.rpc
          .call(
            "groups.acp.topics.archive",
            { groupId: input.groupId, topicId: topic.topicId },
            { signal: AbortSignal.timeout(5000) },
          )
          .catch(() => undefined);
        throw error;
      }
    },
    async rebindGroupTopic(input, signal) {
      await options.ready(signal);
      const selection = await pick(input, signal);
      await options.rpc.call(
        "groups.acp.topics.rebind",
        { groupId: input.groupId, topicId: input.topicId, selection },
        { signal: bounded(signal) },
      );
    },
    async attachGroupTopic(input, signal) {
      await options.ready(signal);
      return options.rpc.call("groups.acp.topics.attach", input, { signal: bounded(signal) });
    },
    async archiveGroupTopic(input, signal) {
      await options.rpc.call("groups.acp.topics.archive", input, { signal: bounded(signal) });
    },
    async sendGroupPrompt(input, signal) {
      await options.ready(signal);
      signal.throwIfAborted();
      // Do not lose an admitted cycle receipt to a local abort; the turn cancels its precise tuple.
      return options.rpc.call("groups.acp.send", input);
    },
    async groupSnapshot(input, signal) {
      return options.rpc.call("groups.acp.snapshot", input, { signal: bounded(signal) });
    },
    async cancelGroup(input, signal) {
      return options.rpc.call("groups.acp.cancel", input, { signal: bounded(signal) });
    },
  };
}
