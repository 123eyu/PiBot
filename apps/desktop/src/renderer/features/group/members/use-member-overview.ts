import type { ChatPeer } from "@pibot/client-core";
import {
  type Bot,
  type Permissions,
  RpcError,
  RpcErrorCodes,
  type Workplaces,
} from "@pibot/protocol";
import { modelDisplayName, waitRpc } from "@pibot/renderer-kit";
import { useEffect, useState } from "react";
import { checkedProfile } from "../../workspace/profile/profile.ts";
import { memberTaskCounts } from "./member-overview.ts";

interface Overview {
  bot?: Bot;
  model?: string;
  memoryCount?: number;
  permissions?: Permissions;
  workplace?: Workplaces;
  counts?: Awaited<ReturnType<typeof memberTaskCounts>>;
  error: boolean;
}

export function useMemberOverview(
  peer: ChatPeer,
  groupId: string,
  botId: string,
  unavailable: () => void,
) {
  const [snapshot, setSnapshot] = useState<{
    peer: ChatPeer;
    groupId: string;
    botId: string;
    data: Overview;
  }>();
  const [revision, setRevision] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit retry starts a new read lifetime.
  useEffect(() => {
    const lifetime = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading = false;
    let dirty = false;
    const read = async () => {
      if (lifetime.signal.aborted) return;
      reading = true;
      dirty = false;
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]);
      const [profile, permissions, workplace, models, counts] = await Promise.allSettled([
        waitRpc(
          async () => checkedProfile(await peer.call("bots.profile", { botId }, { signal }), botId),
          signal,
        ),
        waitRpc(async () => {
          const value = await peer.call("permissions.get", { groupId }, { signal });
          if (value.groupId !== groupId || !value.effective || !value.overrides)
            throw new Error("Permission scope mismatch");
          return value;
        }, signal),
        waitRpc(() => peer.call("workplaces.list", { botId }, { signal }), signal),
        waitRpc(() => peer.call("models.list", { availableOnly: false }, { signal }), signal),
        memberTaskCounts(peer, groupId, botId, signal),
      ]);
      reading = false;
      if (lifetime.signal.aborted) return;
      if (
        (profile.status === "fulfilled" && profile.value.bot.archivedAt) ||
        (profile.status === "rejected" &&
          profile.reason instanceof RpcError &&
          profile.reason.code === RpcErrorCodes.invalidParams)
      ) {
        unavailable();
        return;
      }
      if (!dirty) {
        const bot = profile.status === "fulfilled" ? profile.value.bot : undefined;
        const model =
          models.status === "fulfilled"
            ? models.value.find((m) => m.provider === bot?.modelProvider && m.id === bot?.modelId)
            : undefined;
        setSnapshot({
          peer,
          groupId,
          botId,
          data: {
            bot,
            model: model && modelDisplayName(model.name),
            memoryCount: profile.status === "fulfilled" ? profile.value.memories.length : undefined,
            permissions: permissions.status === "fulfilled" ? permissions.value : undefined,
            workplace: workplace.status === "fulfilled" ? workplace.value : undefined,
            counts: counts.status === "fulfilled" ? counts.value : undefined,
            error: [profile, permissions, workplace, models, counts].some(
              (r) => r.status === "rejected",
            ),
          },
        });
      } else schedule();
    };
    const schedule = () => {
      dirty = true;
      if (reading || lifetime.signal.aborted) return;
      clearTimeout(timer);
      timer = setTimeout(() => void read(), 250);
    };
    const off = [
      peer.on("bots.changed", (e) => {
        if (e.botId !== botId) return;
        if (e.reason === "removed" || e.reason === "archived") {
          lifetime.abort();
          unavailable();
        } else schedule();
      }),
      peer.on("memory.changed", (e) => {
        if (e.botId === botId) schedule();
      }),
      peer.on("permissions.changed", (e) => {
        if ((!e.botId && !e.groupId) || e.groupId === groupId) schedule();
      }),
      peer.on("providers.changed", schedule),
      peer.on("group.task", (e) => {
        if (e.task.groupId === groupId) schedule();
      }),
      peer.on("groups.changed", (e) => {
        if (e.groupId === groupId) schedule();
      }),
    ];
    void read();
    return () => {
      lifetime.abort();
      clearTimeout(timer);
      for (const unsubscribe of off) unsubscribe();
    };
  }, [peer, groupId, botId, unavailable, revision]);
  const data =
    snapshot?.peer === peer && snapshot.groupId === groupId && snapshot.botId === botId
      ? snapshot.data
      : undefined;
  return { data, retry: () => setRevision((v) => v + 1) };
}
