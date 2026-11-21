import type { Bot, Group, SidebarEntry } from "@pibot/protocol";
import { type Summary, useRpc, useSettings, useWorkspace } from "@pibot/renderer-kit";
import { useEffect } from "react";
import type { StartupSnapshot } from "../../shared/startup-snapshot.ts";
import { firstSentence, messagePreview, summaryPreview } from "../features/sidebar/preview.ts";
import { snapshotLook, snapshotMembers } from "./startup-avatar.tsx";
import { useStartupDisplay } from "./startup-display.tsx";

type Translate = ReturnType<typeof useSettings>["t"];

const isoTime = (value?: string) => {
  const time = value ? new Date(value) : undefined;
  return time && !Number.isNaN(time.getTime()) ? time.toISOString() : undefined;
};

/** One sidebar row as ConversationRow would draw it when the Bot is idle. */
function snapshotEntry(
  entry: SidebarEntry,
  bots: ReadonlyMap<string, Bot>,
  groups: ReadonlyMap<string, Group>,
  summary: Summary | undefined,
  t: Translate,
): StartupSnapshot["entries"][number] {
  const [kind, id = ""] = entry.conversationKey.split(":");
  const group = kind === "group" ? groups.get(id) : undefined;
  const bot = kind === "group" ? undefined : bots.get(id);
  const time = isoTime(summary?.updatedAt ?? bot?.updatedAt ?? group?.updatedAt);
  const preview = summary?.failed
    ? t("workspace.failedPreview", { reason: firstSentence(t(`errors.${summary.failed}`)) })
    : messagePreview(
        summary ? summaryPreview(summary, t) : (bot?.description ?? group?.announcement ?? ""),
      );
  return {
    key: entry.conversationKey,
    name: (group?.name ?? bot?.name)?.slice(0, 200) ?? "Pi Bot",
    unread: entry.unread,
    ...(entry.pinnedAt ? { pinned: true } : {}),
    ...(bot?.isMain ? { main: true } : {}),
    ...(entry.groupId ? { sectionId: entry.groupId } : {}),
    ...(time ? { time } : {}),
    preview: preview.slice(0, 200),
    ...(summary?.failed ? { failed: true } : {}),
    ...(group
      ? snapshotMembers(group.members.map((member) => bots.get(member.botId)))
      : { avatar: snapshotLook(bot) }),
  };
}

/** Capture projections already loaded by the UI; no additional history requests or credentials. */
export function StartupCapture() {
  const { peer, state } = useRpc();
  const { settings, t } = useSettings();
  const workspace = useWorkspace();
  const display = useStartupDisplay();
  const setSnapshot = display?.setSnapshot;
  const setConversation = display?.setConversation;
  const setHistorySettled = display?.setHistorySettled;
  const conversation = display?.conversation;
  const cleared = display?.cleared;
  const awaitingHistory = !!display?.snapshot?.conversation && !conversation;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new authenticated peer invalidates the previous history readiness
  useEffect(() => {
    setConversation?.(undefined);
    setHistorySettled?.(false);
  }, [peer, setConversation, setHistorySettled]);
  useEffect(() => {
    if (
      !peer ||
      state !== "ready" ||
      !settings?.onboardingCompleted ||
      workspace.loading ||
      workspace.detailsLoading ||
      workspace.detailsError ||
      workspace.error ||
      !setSnapshot ||
      cleared ||
      awaitingHistory
    )
      return;
    const bots = new Map(workspace.bots.map((bot) => [bot.id, bot]));
    const groups = new Map(workspace.groups.map((group) => [group.id, group]));
    const snapshot: StartupSnapshot = {
      version: 1,
      language: settings.language,
      theme: settings.theme,
      entries: workspace.entries
        .slice(0, 50)
        .map((entry) =>
          snapshotEntry(entry, bots, groups, workspace.summaries[entry.conversationKey], t),
        ),
      sections: workspace.sections.slice(0, 50).map((section) => ({
        id: section.id,
        name: section.name.slice(0, 200),
        collapsed: section.collapsed,
      })),
      inboxCount: Math.min(1_000_000, workspace.inboxCount),
      ...(settings.userAvatar ? { userAvatarImage: true } : {}),
      ...(conversation ? { conversation } : {}),
    };
    const timer = setTimeout(() => {
      setSnapshot(snapshot);
      void window.pibotStartup?.save(snapshot).catch(() => {
        /* A display cache cannot reject authoritative UI updates. */
      });
    }, 500);
    return () => clearTimeout(timer);
  }, [
    peer,
    state,
    settings,
    t,
    workspace.entries,
    workspace.bots,
    workspace.groups,
    workspace.sections,
    workspace.summaries,
    workspace.inboxCount,
    workspace.loading,
    workspace.detailsLoading,
    workspace.detailsError,
    workspace.error,
    conversation,
    cleared,
    awaitingHistory,
    setSnapshot,
  ]);
  return null;
}
