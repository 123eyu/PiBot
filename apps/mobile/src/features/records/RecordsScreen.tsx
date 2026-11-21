import { collapseRepeats } from "@pibot/client-core";
import { useRouter } from "expo-router";
import { Fragment, useMemo, useRef, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import type { MobileKey } from "../../i18n/messages.ts";
import { useLanguage, useLinkState, useText } from "../../runtime/context.tsx";
import { errorKey } from "../../runtime/errors.ts";
import { type } from "../../theme/scale.ts";
import { useColors } from "../../theme/use-theme.ts";
import {
  Button,
  EmptyState,
  ErrorLine,
  FootNote,
  ListCard,
  SectionTitle,
  Separator,
} from "../../ui/controls.tsx";
import { NavBar, OfflineBanner } from "../../ui/headers.tsx";
import { useTimeText } from "../../ui/time.ts";
import { useConversations } from "../conversations/conversations-context.tsx";
import {
  filterRecords,
  type RecordFilter,
  type RecordRow,
  type RecordScope,
  recordFilters,
} from "./model.ts";
import { presentRecord, type RecordView } from "./present.ts";
import { FilterPill, RecordItem } from "./RecordRows.tsx";
import { useRecords } from "./records-context.tsx";
import { ScopeSheet } from "./ScopeSheet.tsx";
import { FULL_SYNC } from "./sync.ts";
import { useRecordPresent } from "./use-present.ts";

const filterLabel: Record<RecordFilter, MobileKey> = {
  all: "recordFilterAll",
  chat: "recordFilterChat",
  routine: "recordFilterRoutine",
  command: "recordFilterCommand",
  connector: "recordFilterConnector",
  failed: "recordFilterFailed",
};
/** Groups shown before "load earlier"; the copy itself is bounded by the sync caps. */
const PAGE = 120;
type Item = { row: RecordRow; view: RecordView };

function dayKey(iso: string) {
  const date = new Date(iso);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}
/**
 * The computer's 记录 page on the phone: read-only, last 3 days, from the phone's
 * copy kept by the background sync, so it also opens offline. Same filters as the desktop's
 * request: all / chats / routines / commands / apps / failed, plus one Bot or group.
 */
export function RecordsScreen() {
  const router = useRouter(),
    t = useText(),
    colors = useColors(),
    time = useTimeText(),
    language = useLanguage(),
    mobile = useLinkState(),
    conversations = useConversations(),
    records = useRecords(),
    { context, filters } = useRecordPresent();
  const [filter, setFilter] = useState<RecordFilter>("all");
  const [scope, setScope] = useState<RecordScope>();
  const [picking, setPicking] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(PAGE);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<MobileKey>();
  const refresh = useRef<AbortController | undefined>(undefined);
  const online = mobile.status === "online";
  const rows = useMemo(
    () => filterRecords(records.rows, filter, scope, filters),
    [records.rows, filter, scope, filters],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: the context is rebuilt each render; its inputs are listed.
  const days = useMemo(() => {
    const sections: {
      key: string;
      at: string;
      groups: ReturnType<typeof collapseRepeats<Item>>;
    }[] = [];
    const byDay = new Map<string, Item[]>();
    for (const row of rows) {
      const key = dayKey(row.at);
      let items = byDay.get(key);
      if (!items) {
        items = [];
        byDay.set(key, items);
        sections.push({ key, at: row.at, groups: [] });
      }
      items.push({ row, view: presentRecord(row, context) });
    }
    for (const section of sections)
      section.groups = collapseRepeats(
        byDay.get(section.key) ?? [],
        (item) => item.row.id,
        (item) => item.view.repeatKey,
      );
    return sections;
  }, [rows, language, conversations.bots, conversations.rows]);
  const dayLabel = (iso: string) => {
    const date = new Date(iso);
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (date.toDateString() === now.toDateString()) return t("today");
    if (date.toDateString() === yesterday.toDateString()) return t("yesterday");
    return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en", {
      month: "long",
      day: "numeric",
      weekday: "short",
    }).format(date);
  };
  const pull = async () => {
    if (!online) return;
    refresh.current?.abort();
    const abort = new AbortController();
    refresh.current = abort;
    setRefreshing(true);
    setError(undefined);
    try {
      await records.sync(FULL_SYNC, abort.signal);
    } catch (cause) {
      if (!abort.signal.aborted) setError(errorKey(cause));
    } finally {
      if (refresh.current === abort) setRefreshing(false);
    }
  };
  const scopeName = scope
    ? (conversations.find(scope.kind, scope.id)?.name ?? t("recordScopeAll"))
    : t("recordScopeAll");
  const open = (row: RecordRow) => router.push({ pathname: "/record", params: { id: row.id } });
  let shown = 0;
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <NavBar title={t("records")} subtitle={t("recordsNote")} onBack={() => router.back()} />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0 }}
        contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingVertical: 10 }}
        accessibilityRole="tablist"
      >
        {recordFilters.map((value) => (
          <FilterPill
            key={value}
            label={t(filterLabel[value])}
            on={filter === value}
            onPress={() => {
              setFilter(value);
              setLimit(PAGE);
            }}
          />
        ))}
        <FilterPill label={scopeName} on={!!scope} trailing onPress={() => setPicking(true)} />
      </ScrollView>
      <ScrollView
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void pull()}
            enabled={online}
            tintColor={colors.text2}
          />
        }
        contentContainerStyle={{ paddingBottom: 12 }}
      >
        {!online && (
          <View style={{ marginHorizontal: 16, marginTop: 2 }}>
            <OfflineBanner text={t("recordsOffline")} />
          </View>
        )}
        <ErrorLine text={error && t(error)} />
        {records.loaded && !records.syncedAt && !records.rows.length ? (
          <EmptyState icon="audit" title={t("recordsNotSynced")} />
        ) : !days.length ? (
          records.loaded && <EmptyState icon="audit" title={t("recordsEmpty")} />
        ) : (
          days.map((day) => {
            if (shown >= limit) return null;
            const groups = day.groups.slice(0, limit - shown);
            shown += groups.length;
            return (
              <View key={day.key}>
                <SectionTitle title={dayLabel(day.at)} />
                <ListCard>
                  {groups.map((group, index) => {
                    const first = group.rows[0] as Item;
                    const last = group.rows.at(-1) as Item;
                    const repeated = group.rows.length > 1;
                    const isOpen = expanded.has(group.id);
                    return (
                      <Fragment key={group.id}>
                        {index > 0 && <Separator />}
                        <RecordItem
                          view={first.view}
                          when={
                            repeated
                              ? `${time.clock(last.row.at)}–${time.clock(first.row.at)}`
                              : time.clock(first.row.at)
                          }
                          count={group.rows.length}
                          expanded={isOpen}
                          onPress={() =>
                            repeated
                              ? setExpanded((value) => {
                                  const next = new Set(value);
                                  if (!next.delete(group.id)) next.add(group.id);
                                  return next;
                                })
                              : open(first.row)
                          }
                        />
                        {repeated &&
                          isOpen &&
                          group.rows.map((item) => (
                            <Fragment key={item.row.id}>
                              <Separator />
                              <RecordItem
                                nested
                                view={item.view}
                                when={time.clock(item.row.at)}
                                onPress={() => open(item.row)}
                              />
                            </Fragment>
                          ))}
                      </Fragment>
                    );
                  })}
                </ListCard>
              </View>
            );
          })
        )}
        {days.reduce((sum, day) => sum + day.groups.length, 0) > limit && (
          <Button
            title={context.shared("activity.more")}
            style={{ alignSelf: "center", marginTop: 16 }}
            onPress={() => setLimit((value) => value + PAGE)}
          />
        )}
        {records.truncated && (
          <Text
            style={[type.caption, { color: colors.text2, paddingHorizontal: 20, paddingTop: 14 }]}
          >
            {t("recordsTruncated")}
          </Text>
        )}
        {!!records.syncedAt && (
          <Text
            style={[type.caption, { color: colors.text2, paddingHorizontal: 20, paddingTop: 10 }]}
          >
            {t("recordsSynced", { time: time.stamp(new Date(records.syncedAt).toISOString()) })}
          </Text>
        )}
        <FootNote text={t("recordsFoot")} />
      </ScrollView>
      <ScopeSheet
        visible={picking}
        value={scope}
        onClose={() => setPicking(false)}
        onPick={(value) => {
          setScope(value);
          setLimit(PAGE);
          setPicking(false);
        }}
      />
    </View>
  );
}
