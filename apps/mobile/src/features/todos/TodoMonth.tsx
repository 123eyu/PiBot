import { dayKey, monthDays, weekLanes } from "@pibot/client-core";
import { Pressable, Text, View } from "react-native";
import { useLanguage } from "../../runtime/context.tsx";
import { usePageTint } from "../../theme/page-tint.tsx";
import { type } from "../../theme/scale.ts";
import { tintOf } from "../../theme/tint.ts";
import { type Colors, useColors } from "../../theme/use-theme.ts";
import type { TodoRow } from "./model.ts";

export const locale = (language: string) => (language === "zh" ? "zh-CN" : "en");
export function todoColor(colors: Colors, row: Pick<TodoRow, "color">) {
  return colors[`todo-${row.color ?? "apricot"}` as keyof Colors];
}
const multiDay = (row: TodoRow) => !!row.endAt && !!row.dueAt && row.endAt > row.dueAt.slice(0, 10);
const MAX_DOTS = 3;

/**
 * A month of whole weeks, Sunday first. With `rows`, each day shows a dot per one-day to-do and
 * multi-day to-dos run as thin bars across the week (the desktop calendar's lanes); without, it
 * is the date picker of the edit sheet.
 */
export function TodoMonth({
  month,
  selected,
  onSelect,
  rows,
}: {
  month: string;
  selected: string | undefined;
  onSelect: (day: string) => void;
  rows?: readonly TodoRow[];
}) {
  const colors = useColors(),
    language = useLanguage(),
    tone = tintOf(colors, usePageTint());
  const days = monthDays(month);
  const today = dayKey(new Date());
  const weekday = new Intl.DateTimeFormat(locale(language), { weekday: "narrow" });
  const label = new Intl.DateTimeFormat(locale(language), { dateStyle: "full" });
  const dated = rows?.filter((row) => row.dueAt) ?? [];
  // Open ones claim the lanes first, as on the desktop.
  const bars = dated
    .filter(multiDay)
    .sort((a, b) => Number(a.status === "done") - Number(b.status === "done"));
  // One pass instead of a scan per cell: a one-day to-do sits on its due day only.
  const singlesByDay = new Map<string, TodoRow[]>();
  for (const row of dated) {
    if (multiDay(row)) continue;
    const day = row.dueAt?.slice(0, 10) ?? "";
    singlesByDay.set(day, [...(singlesByDay.get(day) ?? []), row]);
  }
  const weeks = Array.from({ length: days.length / 7 }, (_, index) =>
    days.slice(index * 7, index * 7 + 7),
  );
  return (
    <View>
      <View style={{ flexDirection: "row" }}>
        {weeks[0]?.map((day) => (
          <Text
            key={dayKey(day)}
            style={[type.time, { flex: 1, textAlign: "center", color: colors.text2 }]}
          >
            {weekday.format(day)}
          </Text>
        ))}
      </View>
      {weeks.map((week) => {
        const keys = week.map(dayKey);
        const lanes = rows ? weekLanes(keys, bars, 2) : [];
        return (
          <View key={keys[0]} style={{ flexDirection: "row" }}>
            {week.map((day, index) => {
              const key = keys[index] as string;
              const outside = !key.startsWith(month);
              const isSelected = key === selected;
              const isToday = key === today;
              const singles = singlesByDay.get(key) ?? [];
              const placement = lanes[index];
              return (
                <Pressable
                  key={key}
                  accessibilityRole="button"
                  accessibilityLabel={label.format(day)}
                  accessibilityState={{ selected: isSelected }}
                  onPress={() => onSelect(key)}
                  style={{
                    flex: 1,
                    alignItems: "stretch",
                    paddingTop: 4,
                    minHeight: rows ? 58 : 40,
                  }}
                >
                  <View
                    style={{
                      alignSelf: "center",
                      width: 30,
                      height: 30,
                      borderRadius: 15,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: isSelected ? tone.fill : "transparent",
                      borderWidth: isToday && !isSelected ? 1.5 : 0,
                      borderColor: tone.ink,
                    }}
                  >
                    <Text
                      style={[
                        type.chip,
                        {
                          color: isSelected
                            ? tone.onFill
                            : isToday
                              ? tone.ink
                              : outside
                                ? colors.text2
                                : colors.text,
                          fontWeight: isSelected || isToday ? "700" : "400",
                          opacity: outside && !isSelected ? 0.55 : 1,
                        },
                      ]}
                    >
                      {day.getDate()}
                    </Text>
                  </View>
                  {placement?.lanes.map((row, lane) => {
                    if (!row)
                      // biome-ignore lint/suspicious/noArrayIndexKey: the two lanes are fixed positions, not items.
                      return <View key={`lane-${lane}`} style={{ height: 3, marginTop: 2 }} />;
                    const start = row.dueAt?.slice(0, 10) ?? key;
                    const joinsLeft = index > 0 && key > start;
                    const joinsRight = index < 6 && !!row.endAt && key < row.endAt;
                    return (
                      <View
                        key={row.id}
                        style={{
                          height: 3,
                          marginTop: 2,
                          marginLeft: joinsLeft ? 0 : 5,
                          marginRight: joinsRight ? 0 : 5,
                          borderTopLeftRadius: joinsLeft ? 0 : 2,
                          borderBottomLeftRadius: joinsLeft ? 0 : 2,
                          borderTopRightRadius: joinsRight ? 0 : 2,
                          borderBottomRightRadius: joinsRight ? 0 : 2,
                          backgroundColor: todoColor(colors, row),
                          opacity: row.status === "done" ? 0.4 : 1,
                        }}
                      />
                    );
                  })}
                  {singles.length > 0 && (
                    <View
                      style={{
                        flexDirection: "row",
                        justifyContent: "center",
                        alignItems: "center",
                        gap: 3,
                        marginTop: 3,
                      }}
                    >
                      {singles.slice(0, MAX_DOTS).map((row) => (
                        <View
                          key={row.id}
                          style={{
                            width: 5,
                            height: 5,
                            borderRadius: 3,
                            backgroundColor: todoColor(colors, row),
                            opacity: row.status === "done" ? 0.4 : 1,
                          }}
                        />
                      ))}
                      {singles.length > MAX_DOTS && (
                        <Text style={{ fontSize: 9, lineHeight: 10, color: colors.text2 }}>+</Text>
                      )}
                    </View>
                  )}
                </Pressable>
              );
            })}
          </View>
        );
      })}
    </View>
  );
}
