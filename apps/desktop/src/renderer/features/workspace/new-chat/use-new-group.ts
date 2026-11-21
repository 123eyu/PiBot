import type { Bot } from "@pibot/protocol";
import { useAction, useNavigation, useRpc, useWorkspace } from "@pibot/renderer-kit";
import { useState } from "react";
import { useCatalog } from "../profile/catalog.ts";

/** Groups take 2–6 Bots; the brain rechecks the limit, the dialog keeps the picker honest. */
export const MAX_GROUP_MEMBERS = 6;

/** "New group chat": pick members, name the group, choose who coordinates. */
export function useNewGroup() {
  const { peer } = useRpc();
  const { navigate } = useNavigation();
  const data = useWorkspace();
  const catalog = useCatalog();
  const task = useAction();
  const pi = data.bots.find((bot) => bot.isMain);
  const [query, setQuery] = useState("");
  const [pickedBots, setPickedBots] = useState<Bot[]>([]);
  const picked = pickedBots.map((bot) => bot.id);
  const [groupName, setGroupName] = useState("");
  const [coordinator, setCoordinator] = useState("");
  const bots = data.bots.filter((bot) => !bot.archivedAt);
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  // A catalog refresh can drop a later page. Keep selected chips removable until the RPC rechecks membership.
  const selectedBots = pickedBots.map((bot) => byId.get(bot.id) ?? bot);
  // An external agent has no Pi Bot planning tools, so it cannot coordinate a group.
  const coordinators = selectedBots.filter(
    (bot) => bot.category !== "image" && bot.kind !== "agent",
  );
  const coordinatorId = coordinators.some((bot) => bot.id === coordinator)
    ? coordinator
    : (coordinators.find((bot) => bot.id === pi?.id)?.id ?? coordinators[0]?.id ?? "");
  const needle = query.trim().toLocaleLowerCase();
  const matches = bots.filter((bot) => bot.name.toLocaleLowerCase().includes(needle));
  const textBots = matches.filter((bot) => bot.category !== "image");
  const imageBots = matches.filter((bot) => bot.category === "image");
  const uncertain = task.error === "workspace.createUncertain";
  const toggle = (bot: Bot) => {
    if (task.busy) return;
    setPickedBots((previous) =>
      previous.some((member) => member.id === bot.id)
        ? previous.filter((member) => member.id !== bot.id)
        : previous.length < MAX_GROUP_MEMBERS
          ? [...previous, bot]
          : previous,
    );
  };
  const createGroup = () => {
    if (!peer || picked.length < 2 || picked.length > MAX_GROUP_MEMBERS || uncertain) return;
    if (selectedBots.length !== picked.length || !coordinatorId) return;
    void task
      .run(() =>
        peer.call("groups.create", {
          name:
            groupName.trim() ||
            selectedBots
              .map((bot) => bot.name)
              .join("、")
              .slice(0, 200),
          botIds: picked,
          coordinatorBotId: coordinatorId,
        }),
      )
      .then((group) => {
        if (!group) return;
        navigate({ name: "chat", groupId: group.id });
        void data.refresh();
      });
  };
  return {
    data,
    catalog,
    task,
    query,
    setQuery,
    textBots,
    imageBots,
    filtered: [...textBots, ...imageBots],
    selectedBots,
    picked,
    toggle,
    removePicked: (id: string) =>
      setPickedBots((members) => members.filter((bot) => bot.id !== id)),
    coordinators,
    coordinatorId,
    setCoordinator,
    groupName,
    setGroupName,
    uncertain,
    createGroup,
  };
}

export type NewGroupState = ReturnType<typeof useNewGroup>;
