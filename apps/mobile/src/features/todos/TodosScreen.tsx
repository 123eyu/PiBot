import { dayDate, dayKey, shiftMonth, todoOnDay } from "@pibot/client-core";
import { useIsFocused } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useLanguage, useSharedText, useText } from "../../runtime/context.tsx";
import { space, type } from "../../theme/scale.ts";
import { useColors } from "../../theme/use-theme.ts";
import { Banner, ErrorLine, FootNote, ListCard, SectionTitle } from "../../ui/controls.tsx";
import { HeaderPill, OfflineBanner, TabHeader } from "../../ui/headers.tsx";
import { Icon } from "../../ui/icons.tsx";
import { useTabBarInset } from "../../ui/tab-bar.tsx";
import { useTimeText } from "../../ui/time.ts";
import { useToast } from "../../ui/toast.tsx";
import type { TodoRow } from "./model.ts";
import { locale, TodoMonth } from "./TodoMonth.tsx";
import { dayOrder, TodoList } from "./TodoRows.tsx";
import { TodoSheet } from "./TodoSheet.tsx";
import { useTodos } from "./todos-context.tsx";

/**
 * The To-dos tab (maintainers 2026-11-20): a month calendar on top, the chosen day's to-dos under
 * it and the undated ones last. It reads the phone's copy, so it works with the computer offline.
 */
export function TodosScreen() {
  const colors = useColors(),
    t = useText(),
    shared = useSharedText(),
    language = useLanguage(),
    time = useTimeText(),
    todos = useTodos(),
    tabInset = useTabBarInset(),
    toast = useToast(),
    focused = useIsFocused();
  const [selected, setSelected] = useState(() => dayKey(new Date()));
  const [editing, setEditing] = useState<{ row?: TodoRow; date?: string }>();
  const [undatedOpen, setUndatedOpen] = useState(false);
  const month = selected.slice(0, 7);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the month on screen is the only input.
  useEffect(() => todos.view(month), [month]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus is the only input.
  useEffect(() => todos.setVisible(focused), [focused]);
  const { day, undated } = useMemo(
    () => ({
      day: todos.rows.filter((row) => todoOnDay(row, selected)).sort(dayOrder),
      undated: todos.rows
        .filter((row) => !row.dueAt && row.status === "open")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    }),
    [todos.rows, selected],
  );
  const monthHasAny = useMemo(() => {
    const first = `${month}-01`,
      last = `${month}-31`;
    return todos.rows.some((row) => {
      const start = row.dueAt?.slice(0, 10);
      return !!start && start <= last && (row.endAt ?? start) >= first;
    });
  }, [todos.rows, month]);
  // The computer counts every undated one; the phone may hold only the first pages of them.
  const undatedCount = todos.openComplete
    ? undated.length
    : Math.max(undated.length, todos.undatedCount);
  const title = new Intl.DateTimeFormat(locale(language), { year: "numeric", month: "long" });
  // "11月20日 周五" / "Fri, November 20": Intl runs the Chinese parts together without a space.
  const monthDay = new Intl.DateTimeFormat(locale(language), { month: "long", day: "numeric" });
  const weekday = new Intl.DateTimeFormat(locale(language), { weekday: "short" });
  const dayText = (key: string) => {
    const date = dayDate(key);
    return language === "zh"
      ? `${monthDay.format(date)} ${weekday.format(date)}`
      : `${weekday.format(date)}, ${monthDay.format(date)}`;
  };
  const goMonth = (delta: number) => {
    const next = shiftMonth(month, delta);
    const today = dayKey(new Date());
    setSelected(today.startsWith(next) ? today : `${next}-01`);
  };
  // Only a full queue refuses an edit.
  const toggle = (row: TodoRow) =>
    void todos
      .setStatus(row, row.status === "open" ? "done" : "open")
      .catch(() => toast(t("todoQueueFull")));
  const loading = !todos.ready || (todos.syncing && !todos.syncedAt);
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <TabHeader
        title={title.format(dayDate(`${month}-01`))}
        tab="todos"
        subtitle={
          todos.syncedAt ? t("todoSyncedAt", { time: time.stamp(todos.syncedAt) }) : undefined
        }
        actions={
          <View style={{ flexDirection: "row", gap: 6 }}>
            <HeaderPill
              icon="back"
              label={shared("personalTodos.previous")}
              onPress={() => goMonth(-1)}
            />
            <HeaderPill
              icon="chevronRight"
              label={shared("personalTodos.next")}
              onPress={() => goMonth(1)}
            />
            <HeaderPill
              icon="plus"
              prim
              label={shared("personalTodos.new")}
              onPress={() => setEditing({ date: selected })}
            />
          </View>
        }
      />
      <ScrollView
        contentContainerStyle={{ paddingBottom: tabInset }}
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={() => todos.refresh()}
            tintColor={colors.text2}
          />
        }
      >
        <View style={{ marginHorizontal: space.page, gap: 8 }}>
          {!todos.online && (
            <OfflineBanner text={t(todos.syncedAt ? "todoOffline" : "todoNeverSynced")} />
          )}
          {todos.dropped.changed > 0 && (
            <Banner
              tone="warn"
              icon="info"
              text={t("todoDroppedChanged", { count: todos.dropped.changed })}
              action={{ title: t("close"), onPress: todos.dismissDropped }}
            />
          )}
          {todos.dropped.failed > 0 && (
            <Banner
              tone="warn"
              icon="info"
              text={t("todoDroppedFailed", { count: todos.dropped.failed })}
              action={{ title: t("close"), onPress: todos.dismissDropped }}
            />
          )}
        </View>
        <ErrorLine text={todos.online && todos.error ? t(todos.error) : undefined} />
        <ListCard style={{ marginTop: 8, paddingHorizontal: 6, paddingVertical: 8 }}>
          <TodoMonth month={month} selected={selected} onSelect={setSelected} rows={todos.rows} />
        </ListCard>
        {!loading && !monthHasAny && (
          <Text
            style={[
              type.caption,
              { color: colors.text2, textAlign: "center", paddingTop: 10, paddingHorizontal: 24 },
            ]}
          >
            {t("todoEmptyMonth")}
          </Text>
        )}
        <SectionTitle title={t("todoDayCount", { date: dayText(selected), count: day.length })} />
        <ListCard>
          {day.length ? (
            <TodoList
              rows={day}
              pending={todos.pending}
              onToggle={toggle}
              onOpen={(row) => setEditing({ row })}
            />
          ) : (
            <Text style={[type.body, { color: colors.text2, padding: 16 }]}>
              {loading ? t("loading") : shared("personalTodos.emptyDay")}
            </Text>
          )}
        </ListCard>
        {undatedCount > 0 && (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: undatedOpen }}
              onPress={() => setUndatedOpen(!undatedOpen)}
            >
              <SectionTitle
                title={t("todoUndated", { count: undatedCount })}
                right={
                  <Icon
                    name={undatedOpen ? "chevron" : "chevronRight"}
                    color={colors.text2}
                    size={16}
                  />
                }
              />
            </Pressable>
            {undatedOpen && (
              <ListCard>
                <TodoList
                  rows={undated}
                  pending={todos.pending}
                  onToggle={toggle}
                  onOpen={(row) => setEditing({ row })}
                />
              </ListCard>
            )}
          </>
        )}
        <FootNote text={t("todosFoot")} />
      </ScrollView>
      {editing && (
        <TodoSheet
          row={editing.row}
          initialDate={editing.date}
          onClose={() => setEditing(undefined)}
          onSave={(fields) =>
            editing.row ? todos.update(editing.row, fields) : todos.create(fields)
          }
          onDelete={(row) => todos.remove(row)}
        />
      )}
    </View>
  );
}
