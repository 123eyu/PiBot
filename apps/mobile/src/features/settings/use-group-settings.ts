import { Methods } from "@pibot/protocol";
import { z } from "zod";
import { useRuntime, useText } from "../../runtime/context.tsx";
import { confirmLocally } from "../../runtime/local-auth.ts";
import {
  addMember,
  type GroupPatch,
  type GroupSettings,
  readGroupSettings,
  removeGroupMemory,
  removeMember,
  setGroupMode,
  updateGroup,
} from "./calls.ts";
import { useSettingsData } from "./use-settings-data.ts";

const GroupSettingsSchema = z.object({
  group: Methods["groups.get"].result,
  bots: Methods["bots.list"].result,
  memory: Methods["groups.memory.list"].result.optional(),
  execution: Methods["groups.execution.get"].result.optional(),
}) as unknown as z.ZodType<GroupSettings>;

/** Everything the phone's group settings pages show and change, for one group. */
export function useGroupSettings(groupId: string) {
  const runtime = useRuntime(),
    t = useText();
  const unlock =
    (prompt: "unlockMember" | "unlockGroupMemory", fallback: AbortSignal) =>
    (signal?: AbortSignal) =>
      confirmLocally(t(prompt), t("cancel"), signal ?? fallback);
  const state = useSettingsData({
    key: `group:${groupId}`,
    read: (signal) => readGroupSettings(runtime, groupId, signal),
    schema: GroupSettingsSchema,
    subscribe: (peer, refresh) => {
      const mine = (event: { groupId: string }) => {
        if (event.groupId === groupId) refresh();
      };
      return [
        peer.on("groups.changed", mine),
        peer.on("groups.resources.changed", mine),
        peer.on("groups.execution.changed", mine),
        // Member names and avatars come from the Bots.
        peer.on("bots.changed", refresh),
      ];
    },
  });
  return {
    ...state,
    group: state.data?.group,
    update: (patch: GroupPatch) =>
      state.apply((signal) => updateGroup(runtime, groupId, patch, signal)),
    setMember: (botId: string, member: boolean) =>
      state.apply((signal) =>
        member
          ? addMember(runtime, groupId, botId, signal)
          : removeMember(runtime, groupId, botId, unlock("unlockMember", signal), signal),
      ),
    removeMemory: (id: string) =>
      state.apply((signal) =>
        removeGroupMemory(runtime, groupId, id, unlock("unlockGroupMemory", signal), signal),
      ),
    setMode: (mode: "execute" | "plan") =>
      state.apply(async (signal) => {
        const current = state.data?.execution;
        if (!current) throw new Error("invalid");
        return setGroupMode(runtime, groupId, current.version, mode, signal);
      }),
  };
}
export type GroupSettingsState = ReturnType<typeof useGroupSettings>;
