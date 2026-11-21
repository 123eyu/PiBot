import { Pressable, Text, View } from "react-native";
import { useText } from "../../runtime/context.tsx";
import { radius, space, type } from "../../theme/scale.ts";
import { useColors } from "../../theme/use-theme.ts";
import { type AvatarState, BotAvatar } from "../../ui/avatar.tsx";
import { type StateKind, StateTag } from "../../ui/controls.tsx";
import { Icon } from "../../ui/icons.tsx";
import type { RecordView, Tone } from "./present.ts";

const tagKind: Partial<Record<Tone, StateKind>> = {
  ok: "done",
  danger: "fail",
  warn: "wait",
  running: "run",
};
const lookState: Record<Tone, AvatarState> = {
  ok: "idle",
  danger: "blocked",
  warn: "waiting",
  running: "working",
  muted: "idle",
};
/** The outcome as the task center shows states; a neutral one stays plain text. */
export function Outcome({ outcome }: { outcome: RecordView["outcome"] }) {
  const colors = useColors();
  const kind = tagKind[outcome.tone];
  if (kind) return <StateTag kind={kind} label={outcome.text} />;
  return <Text style={[type.caption, { color: colors.text2 }]}>{outcome.text}</Text>;
}
/**
 * One record line in the v3 list style (task center rows): avatar, the sentence, then outcome,
 * category, Bot and time. A collapsed run of identical records shows ×N and its time range.
 */
export function RecordItem({
  view,
  when,
  count,
  expanded,
  nested,
  onPress,
}: {
  view: RecordView;
  when: string;
  count?: number;
  expanded?: boolean;
  nested?: boolean;
  onPress: () => void;
}) {
  const colors = useColors(),
    t = useText();
  const repeated = !!count && count > 1;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={repeated ? t("recordRepeatHint", { count: count as number }) : undefined}
      accessibilityState={repeated ? { expanded: !!expanded } : undefined}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        minHeight: space.settingsRow,
        paddingVertical: 10,
        paddingLeft: nested ? 60 : 16,
        paddingRight: 16,
        backgroundColor: pressed ? colors.hover : "transparent",
      })}
    >
      {!nested &&
        (view.look ? (
          <BotAvatar bot={view.look} size={32} state={lookState[view.outcome.tone]} />
        ) : (
          <View
            style={{
              width: 32,
              height: 32,
              borderRadius: 16,
              backgroundColor: colors.hover,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="audit" color={colors.text2} size={16} />
          </View>
        ))}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        {!nested && (
          <Text numberOfLines={2} style={[type.rowTitle, { color: colors.text }]}>
            {view.what}
          </Text>
        )}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <Outcome outcome={view.outcome} />
          <Text numberOfLines={1} style={[type.caption, { color: colors.text2, flexShrink: 1 }]}>
            {(nested ? [when] : [view.badge, view.who, when]).filter(Boolean).join(" · ")}
          </Text>
        </View>
      </View>
      {repeated && (
        <View
          style={{
            minWidth: 30,
            height: 22,
            paddingHorizontal: 7,
            borderRadius: radius.pill,
            backgroundColor: colors.hover,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={[type.small, { color: colors.text, fontWeight: "600" }]}>
            {t("recordRepeat", { count: count as number })}
          </Text>
        </View>
      )}
      <Icon name={repeated ? "chevron" : "chevronRight"} color={colors.text2} size={16} />
    </Pressable>
  );
}
/** A filter of the page: the desktop tab look (selected pill on accent tint). */
export function FilterPill({
  label,
  on,
  onPress,
  trailing,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  trailing?: boolean;
}) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      style={({ pressed }) => ({
        height: 32,
        paddingHorizontal: 12,
        borderRadius: radius.pill,
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        backgroundColor: on ? colors.accentBg : colors.hover,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text
        numberOfLines={1}
        style={[
          type.chip,
          { color: on ? colors.accent : colors.text, fontWeight: on ? "600" : "400" },
        ]}
      >
        {label}
      </Text>
      {trailing && <Icon name="chevron" color={on ? colors.accent : colors.text2} size={13} />}
    </Pressable>
  );
}
