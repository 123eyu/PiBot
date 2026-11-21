import { dayDate, dayKey, localDeadline, shiftMonth } from "@pibot/client-core";
import { PersonalTodoColors, PersonalTodoStickers } from "@pibot/protocol";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useLanguage, useSharedText, useText } from "../../runtime/context.tsx";
import { radius, slopFor, type } from "../../theme/scale.ts";
import { useColors } from "../../theme/use-theme.ts";
import { Button, Chip, Field } from "../../ui/controls.tsx";
import { IconButton } from "../../ui/headers.tsx";
import { Sheet, SheetLabel, SheetText, SheetTitle } from "../../ui/sheet.tsx";
import type { TodoFields, TodoRow } from "./model.ts";
import { locale, TodoMonth, todoColor } from "./TodoMonth.tsx";

type Sticker = NonNullable<TodoRow["sticker"]>;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A date row of the sheet: its value, a clear chip, and a month picker under it when open. */
function DateChoice({
  label,
  value,
  empty,
  open,
  onToggle,
  onPick,
  onClear,
}: {
  label: string;
  value: string;
  empty: string;
  open: boolean;
  onToggle: () => void;
  onPick: (day: string) => void;
  onClear?: () => void;
}) {
  const colors = useColors(),
    t = useText(),
    shared = useSharedText(),
    language = useLanguage();
  const [month, setMonth] = useState((value || dayKey(new Date())).slice(0, 7));
  const long = new Intl.DateTimeFormat(locale(language), { dateStyle: "full" });
  const title = new Intl.DateTimeFormat(locale(language), { year: "numeric", month: "long" });
  return (
    <View style={{ gap: 6 }}>
      <SheetLabel text={label} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Chip
          label={value ? long.format(dayDate(value)) : empty}
          icon="calendar"
          trailing={open ? "chevron" : "chevronRight"}
          live={open}
          onPress={onToggle}
        />
        {!!value && onClear && <Chip label={t("todoClear")} icon="close" onPress={onClear} />}
      </View>
      {open && (
        <View
          style={{
            borderRadius: radius.card,
            backgroundColor: colors.card,
            boxShadow: colors["shadow-soft"],
            padding: 8,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <IconButton
              icon="back"
              label={shared("personalTodos.previous")}
              onPress={() => setMonth(shiftMonth(month, -1))}
            />
            <Text style={[type.bodyStrong, { flex: 1, textAlign: "center", color: colors.text }]}>
              {title.format(dayDate(`${month}-01`))}
            </Text>
            <IconButton
              icon="chevronRight"
              label={shared("personalTodos.next")}
              onPress={() => setMonth(shiftMonth(month, 1))}
            />
          </View>
          <TodoMonth month={month} selected={value || undefined} onSelect={onPick} />
        </View>
      )}
    </View>
  );
}

/**
 * Creates or edits one to-do, like the desktop editor: title, date with an optional time, an
 * optional end date, colour and sticker. Saving queues the change (it syncs at once when online).
 */
export function TodoSheet({
  row,
  initialDate,
  onClose,
  onSave,
  onDelete,
}: {
  row?: TodoRow;
  initialDate?: string;
  onClose: () => void;
  onSave: (fields: TodoFields) => Promise<void>;
  onDelete: (row: TodoRow) => Promise<void>;
}) {
  const colors = useColors(),
    t = useText(),
    shared = useSharedText();
  const [title, setTitle] = useState(row?.title ?? "");
  const [date, setDate] = useState(row ? (row.dueAt?.slice(0, 10) ?? "") : (initialDate ?? ""));
  const [time, setTime] = useState(row?.dueAt?.slice(11, 16) ?? "");
  const [endAt, setEndAt] = useState(row?.endAt ?? "");
  const [color, setColor] = useState(row?.color ?? "apricot");
  const [sticker, setSticker] = useState<Sticker | null>(row?.sticker ?? null);
  const [picking, setPicking] = useState<"date" | "end">();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  const invalidEnd = !!endAt && (!date || endAt < date);
  const invalidTime = !!time && (!date || !TIME.test(time));
  const canSave = !!title.trim() && !invalidEnd && !invalidTime && !busy;
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setFailed(undefined);
    try {
      await work();
      onClose();
    } catch (error) {
      setFailed(
        error instanceof Error && error.message === "todo_queue_full"
          ? t("todoQueueFull")
          : t("failed"),
      );
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(() => {
      // Editing only the title must not erase an existing deadline's time and offset.
      const dueAt =
        row && date === row.dueAt?.slice(0, 10) && time === (row.dueAt?.slice(11, 16) ?? "")
          ? row.dueAt
          : date && time
            ? localDeadline(date, time)
            : date || null;
      return onSave({ title: title.trim(), dueAt, color, sticker, endAt: endAt || null });
    });
  return (
    <Sheet visible onClose={onClose}>
      <SheetTitle text={shared(row ? "personalTodos.edit" : "personalTodos.new")} />
      <Field
        value={title}
        onChangeText={setTitle}
        placeholder={shared("personalTodos.title")}
        accessibilityLabel={shared("personalTodos.title")}
        maxLength={500}
        autoFocus={!row}
      />
      <DateChoice
        label={shared("personalTodos.date")}
        value={date}
        empty={t("todoNoDate")}
        open={picking === "date"}
        onToggle={() => setPicking(picking === "date" ? undefined : "date")}
        onPick={(day) => {
          setDate(day);
          setPicking(undefined);
        }}
        onClear={() => {
          setDate("");
          setTime("");
          setEndAt("");
        }}
      />
      {!!date && (
        <View style={{ gap: 6 }}>
          <SheetLabel text={shared("personalTodos.time")} />
          <Field
            value={time}
            onChangeText={setTime}
            placeholder={t("todoTimeHint")}
            accessibilityLabel={shared("personalTodos.time")}
            keyboardType="numbers-and-punctuation"
            maxLength={5}
          />
          {invalidTime && <SheetText small text={t("todoTimeInvalid")} />}
        </View>
      )}
      {!!date && (
        <DateChoice
          label={shared("personalTodos.end")}
          value={endAt}
          empty={t("todoNoEnd")}
          open={picking === "end"}
          onToggle={() => setPicking(picking === "end" ? undefined : "end")}
          onPick={(day) => {
            setEndAt(day);
            setPicking(undefined);
          }}
          onClear={() => setEndAt("")}
        />
      )}
      {invalidEnd && <SheetText small text={shared("personalTodos.invalidEnd")} />}
      <SheetLabel text={shared("personalTodos.color")} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12, paddingHorizontal: 4 }}>
        {PersonalTodoColors.map((key) => (
          <Pressable
            key={key}
            accessibilityRole="radio"
            accessibilityState={{ selected: color === key }}
            accessibilityLabel={shared(`personalTodos.color.${key}`)}
            hitSlop={slopFor(30)}
            onPress={() => setColor(key)}
            style={{
              width: 30,
              height: 30,
              borderRadius: 15,
              backgroundColor: todoColor(colors, { color: key }),
              borderWidth: color === key ? 3 : 0,
              borderColor: colors.text,
            }}
          />
        ))}
      </View>
      <SheetLabel text={shared("personalTodos.sticker")} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Chip
          label={shared("personalTodos.none")}
          live={sticker === null}
          onPress={() => setSticker(null)}
        />
        {(Object.keys(PersonalTodoStickers) as Sticker[]).map((key) => (
          <Pressable
            key={key}
            accessibilityRole="radio"
            accessibilityState={{ selected: sticker === key }}
            accessibilityLabel={shared(`personalTodos.sticker.${key}`)}
            hitSlop={slopFor(36)}
            onPress={() => setSticker(key)}
            style={{
              width: 36,
              height: 36,
              borderRadius: 18,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: sticker === key ? colors.accentBg : colors.hover,
            }}
          >
            <Text style={{ fontSize: 18 }}>{PersonalTodoStickers[key]}</Text>
          </Pressable>
        ))}
      </View>
      {!!failed && <SheetText small text={failed} />}
      <Button
        title={t("save")}
        variant="prim"
        size="lg"
        disabled={!canSave}
        onPress={() => void save()}
      />
      {row &&
        (confirming ? (
          <View style={{ gap: 8 }}>
            <SheetText text={shared("personalTodos.deleteConfirm")} />
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button
                title={t("cancel")}
                size="lg"
                style={{ flex: 1 }}
                onPress={() => setConfirming(false)}
              />
              <Button
                title={shared("personalTodos.delete")}
                variant="dangerFill"
                size="lg"
                style={{ flex: 1 }}
                disabled={busy}
                onPress={() => void run(() => onDelete(row))}
              />
            </View>
          </View>
        ) : (
          <Button
            title={shared("personalTodos.delete")}
            variant="danger"
            size="lg"
            onPress={() => setConfirming(true)}
          />
        ))}
    </Sheet>
  );
}
