import { PersonalTodoStickers } from "@pibot/protocol";
import { Pressable, Text, View } from "react-native";
import { useSharedText, useText } from "../../runtime/context.tsx";
import { slopFor, type } from "../../theme/scale.ts";
import { onFill, useColors } from "../../theme/use-theme.ts";
import { Separator } from "../../ui/controls.tsx";
import { Icon } from "../../ui/icons.tsx";
import type { TodoRow } from "./model.ts";
import { todoColor } from "./TodoMonth.tsx";

/** Open first, then timed ones by their time, all-day ones last, as a day reads. */
export function dayOrder(a: TodoRow, b: TodoRow) {
  const done = Number(a.status === "done") - Number(b.status === "done");
  if (done) return done;
  const time = (row: TodoRow) =>
    row.dueAt && row.dueAt.length > 10 ? row.dueAt.slice(11, 16) : "~";
  return time(a).localeCompare(time(b)) || a.title.localeCompare(b.title);
}

function TodoItem({
  row,
  pending,
  onToggle,
  onOpen,
}: {
  row: TodoRow;
  pending: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const colors = useColors(),
    t = useText(),
    shared = useSharedText();
  const done = row.status === "done";
  const color = todoColor(colors, row);
  const time = row.dueAt && row.dueAt.length > 10 ? row.dueAt.slice(11, 16) : undefined;
  const bot = row.origin?.botName;
  const facts = [
    time,
    bot ? shared("personalTodos.from", { name: bot }) : undefined,
    done ? shared("personalTodos.done") : undefined,
  ].filter(Boolean);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[row.title, ...facts, pending ? t("todoUnsynced") : ""].join(", ")}
      onPress={onOpen}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        minHeight: 56,
        paddingVertical: 10,
        paddingHorizontal: 14,
        backgroundColor: pressed ? colors.hover : "transparent",
      })}
    >
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: done }}
        accessibilityLabel={shared(done ? "personalTodos.reopen" : "personalTodos.complete")}
        hitSlop={slopFor(24)}
        onPress={onToggle}
        style={{
          width: 24,
          height: 24,
          borderRadius: 12,
          borderWidth: 2,
          borderColor: color,
          backgroundColor: done ? color : "transparent",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {done && <Icon name="check" color={onFill(colors)} size={14} strokeWidth={2.4} />}
      </Pressable>
      {row.sticker && (
        <Text style={{ fontSize: 18, opacity: done ? 0.5 : 1 }}>
          {PersonalTodoStickers[row.sticker]}
        </Text>
      )}
      <View style={{ flex: 1, minWidth: 0, gap: 1, opacity: done ? 0.55 : 1 }}>
        <Text
          numberOfLines={2}
          style={[
            type.body,
            { color: colors.text, textDecorationLine: done ? "line-through" : "none" },
          ]}
        >
          {row.title}
        </Text>
        {facts.length > 0 && (
          <Text numberOfLines={1} style={[type.caption, { color: colors.text2 }]}>
            {facts.join(" · ")}
          </Text>
        )}
      </View>
      {pending && (
        <Text
          style={[
            type.small,
            {
              color: colors.warn,
              backgroundColor: colors.warnBg,
              borderRadius: 999,
              paddingHorizontal: 8,
              overflow: "hidden",
            },
          ]}
        >
          {t("todoUnsynced")}
        </Text>
      )}
    </Pressable>
  );
}
export function TodoList({
  rows,
  pending,
  onToggle,
  onOpen,
}: {
  rows: readonly TodoRow[];
  pending: ReadonlySet<string>;
  onToggle: (row: TodoRow) => void;
  onOpen: (row: TodoRow) => void;
}) {
  return rows.map((row, index) => (
    <View key={row.id}>
      {index > 0 && <Separator />}
      <TodoItem
        row={row}
        pending={pending.has(row.id)}
        onToggle={() => onToggle(row)}
        onOpen={() => onOpen(row)}
      />
    </View>
  ));
}
