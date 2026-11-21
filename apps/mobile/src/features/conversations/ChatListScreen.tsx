import { approvalText } from "@pibot/client-core";
import { useRouter } from "expo-router";
import { memo, useCallback, useMemo, useState } from "react";
import { FlatList, RefreshControl, Text, useWindowDimensions, View } from "react-native";
import { useOffline } from "../../offline/OfflineProvider.tsx";
import { useLanguage, useMobileSelector, useText } from "../../runtime/context.tsx";
import { space, type } from "../../theme/scale.ts";
import { useColors } from "../../theme/use-theme.ts";
import { Banner, EmptyState, ErrorLine, SearchField } from "../../ui/controls.tsx";
import { ComputerStatus, HeaderPill, OfflineBanner, TabHeader } from "../../ui/headers.tsx";
import { StatRow } from "../../ui/stats.tsx";
import { useTabBarInset } from "../../ui/tab-bar.tsx";
import { useApprovals } from "../approvals/approvals-context.tsx";
import { OfflineDetailsSheet } from "../offline/OfflineDetailsSheet.tsx";
import { greetingKey, taskCounts } from "../tasks/counts.ts";
import { useTaskCenter } from "../tasks/tasks-context.tsx";
import { ConversationRow, PinnedTile } from "./ConversationRow.tsx";
import { useConversations } from "./conversations-context.tsx";
import { type Conversation, conversationKey } from "./model.ts";

/** Placeholder rows while the first connection runs and nothing is cached yet. */
function Skeleton() {
  const colors = useColors();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: space.rowPad }}
    >
      <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: colors.tert }} />
      <View style={{ flex: 1, gap: 8 }}>
        <View style={{ width: "40%", height: 14, borderRadius: 8, backgroundColor: colors.tert }} />
        <View style={{ width: "75%", height: 12, borderRadius: 8, backgroundColor: colors.tert }} />
      </View>
    </View>
  );
}
/** One line on what needs the user, then working / waiting / done today. */
function HomeSummary() {
  const colors = useColors(),
    t = useText(),
    tasks = useTaskCenter(),
    approvals = useApprovals(),
    list = useConversations();
  const running = Object.values(list.running).filter(Boolean).length;
  const counts = taskCounts(tasks.center, approvals.items.length, running);
  const greet = t(greetingKey());
  const line = counts.waiting
    ? t("homeWaiting", { greet, count: counts.waiting })
    : counts.working
      ? t("homeWorking", { greet, count: counts.working })
      : t("homeIdle", { greet });
  return (
    <View style={{ paddingTop: 10 }}>
      <Text style={[type.caption, { color: colors.text2, paddingHorizontal: 20 }]}>{line}</Text>
      <StatRow
        stats={[
          { label: t("statWorking"), value: counts.working },
          { label: t("statWaiting"), value: counts.waiting, warn: true },
          { label: t("statDoneToday"), value: counts.doneToday },
        ]}
      />
    </View>
  );
}
/** A list row that re-renders only when its conversation or marks change, not with the page. */
const Row = memo(function Row({
  row,
  unread,
  running,
  waiting,
  unavailable,
  onOpen,
}: {
  row: Conversation;
  unread: boolean;
  running: boolean;
  waiting?: string;
  unavailable: boolean;
  onOpen: (row: Conversation) => void;
}) {
  return (
    <ConversationRow
      row={row}
      unread={unread}
      running={running}
      waiting={waiting}
      unavailable={unavailable}
      onPress={() => onOpen(row)}
    />
  );
});
const rowKey = (row: Conversation) => row.key;
const RowGap = () => <View style={{ height: 2 }} />;
const SKELETON = ["a", "b", "c", "d", "e"].map((key) => <Skeleton key={key} />);
/** The desktop sidebar as a page: search, pinned tiles, then every chat by last activity. */
export function ChatListScreen() {
  const colors = useColors(),
    t = useText(),
    language = useLanguage(),
    router = useRouter(),
    mobile = useMobileSelector((s) => ({
      status: s.status,
      reconnecting: s.reconnecting,
      devices: s.devices,
      selectedId: s.selectedId,
    })),
    list = useConversations(),
    approvals = useApprovals(),
    offline = useOffline();
  const [query, setQuery] = useState("");
  const [offlineDetails, setOfflineDetails] = useState(false);
  const tabInset = useTabBarInset();
  // Two tiles per row, as the sidebar's 1fr 1fr grid.
  const tileWidth = (useWindowDimensions().width - space.page * 2 - 8) / 2;
  const online = mobile.status === "online";
  const connecting = mobile.status === "connecting";
  const canReplyOffline = offline.unreachable && offline.ready.length > 0;
  const computer = mobile.devices.find((d) => d.id === mobile.selectedId)?.name ?? "";
  const rows = list.rows.filter((row) =>
    row.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  // A search lists matches flat; the tiles are a shortcut for the unfiltered list only.
  const pinned = query ? [] : rows.filter((row) => row.pinned);
  const rest = query ? rows : rows.filter((row) => !row.pinned);
  // One pass over the approvals instead of a search per row: the waiting line of each chat.
  const waitingByKey = useMemo(() => {
    const groupTopics = new Set(
      list.rows.flatMap((row) => (row.kind === "group" && row.topicId ? [row.topicId] : [])),
    );
    const groupByTopic = new Map(
      list.rows.flatMap((row) =>
        row.kind === "group" && row.topicId ? [[row.topicId, row.key] as const] : [],
      ),
    );
    const byKey = new Map<string, string>();
    for (const card of approvals.items) {
      const groupKey = groupByTopic.get(card.conversationId ?? "");
      const botKey = groupTopics.has(card.conversationId ?? "")
        ? undefined
        : conversationKey("bot", card.botId);
      const title = approvalText(card, language).title;
      const bot = list.bots.get(card.botId)?.name;
      // The first pending card of a chat names it, as the per-row search did.
      if (groupKey && !byKey.has(groupKey)) byKey.set(groupKey, bot ? `${bot}：${title}` : title);
      if (botKey && !byKey.has(botKey)) byKey.set(botKey, title);
    }
    return byKey;
  }, [list.rows, list.bots, approvals.items, language]);
  const open = useCallback(
    (row: Conversation) => router.push(`/conversation/${row.kind}/${row.id}`),
    [router],
  );
  const header = (
    <View style={{ paddingBottom: 2 }}>
      <SearchField value={query} onChangeText={setQuery} placeholder={t("search")} />
      {!online && (
        <View style={{ marginHorizontal: space.page, marginBottom: 10 }}>
          {connecting ? (
            <Banner
              tone="accent"
              icon="spinner"
              text={
                mobile.reconnecting ? t("reconnecting") : t("listConnecting", { name: computer })
              }
            />
          ) : (
            // F17: "sends when the computer is back" only when the phone cannot answer itself.
            <OfflineBanner
              text={t(canReplyOffline ? "listOfflinePhone" : "listOffline")}
              onDetails={() => setOfflineDetails(true)}
              singleLine
            />
          )}
        </View>
      )}
      <ErrorLine text={list.action.error && t(list.action.error)} />
      {pinned.length > 0 && (
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 8,
            paddingHorizontal: space.page,
            paddingBottom: 6,
          }}
        >
          {pinned.map((row) => (
            <View key={row.key} style={{ width: tileWidth }}>
              <PinnedTile
                row={row}
                unread={list.unread.has(row.key)}
                running={online && !!list.running[row.key]}
                waiting={waitingByKey.has(row.key)}
                unavailable={!online && !!row.agent}
                onPress={() => open(row)}
              />
            </View>
          ))}
        </View>
      )}
    </View>
  );
  const empty =
    connecting && !list.rows.length ? (
      <View style={{ gap: 2 }}>{SKELETON}</View>
    ) : !rows.length && !list.action.busy ? (
      <EmptyState
        icon="message"
        title={query ? t("noMatch") : t("noChats")}
        hint={query ? undefined : t("noChatsHint")}
      />
    ) : undefined;
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <TabHeader
        title={t("chat")}
        tab="chat"
        subtitle={<ComputerStatus />}
        actions={
          <>
            <HeaderPill title={t("contacts")} onPress={() => router.push("/contacts")} />
            <HeaderPill
              icon="plus"
              label={t("newGroup")}
              disabled={!online}
              onPress={() => router.push("/settings/new-group")}
            />
          </>
        }
      >
        <HomeSummary />
      </TabHeader>
      <OfflineDetailsSheet
        visible={offlineDetails}
        can={canReplyOffline ? t("offlineDetailsList") : undefined}
        wait={!canReplyOffline ? t("offlineDetailsListWait") : undefined}
        onClose={() => setOfflineDetails(false)}
      />
      {/* Virtualized: a computer with hundreds of Bots and groups mounts only the rows on screen. */}
      <FlatList
        data={connecting && !list.rows.length ? [] : rest}
        keyExtractor={rowKey}
        renderItem={({ item: row }) => (
          <Row
            row={row}
            unread={list.unread.has(row.key)}
            running={online && !!list.running[row.key]}
            waiting={waitingByKey.get(row.key)}
            unavailable={!online && !!row.agent}
            onOpen={open}
          />
        )}
        ItemSeparatorComponent={RowGap}
        ListHeaderComponent={header}
        ListFooterComponent={rest.length ? <View style={{ height: 8 }} /> : undefined}
        ListEmptyComponent={empty}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: tabInset }}
        initialNumToRender={14}
        maxToRenderPerBatch={10}
        windowSize={11}
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={() => void list.load()}
            tintColor={colors.text2}
          />
        }
      />
    </View>
  );
}
