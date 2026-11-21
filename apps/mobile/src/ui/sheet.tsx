import type { ReactNode } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useText } from "../runtime/context.tsx";
import { radius, space, type } from "../theme/scale.ts";
import { useColors } from "../theme/use-theme.ts";
import { Icon, type IconName } from "./icons.tsx";

/**
 * Bottom sheet over a scrim; it replaces the desktop's popovers and dialogs and keeps their
 * structure ("section title + card of rows"). Tapping the scrim or system back closes it.
 */
export function Sheet({
  visible,
  onClose,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const colors = useColors(),
    insets = useSafeAreaInsets(),
    t = useText();
  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: colors.overlay }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("close")}
          style={{ flex: 1 }}
          onPress={onClose}
        />
        <View
          accessibilityViewIsModal
          style={{
            backgroundColor: colors.bg,
            borderTopLeftRadius: radius.sheet,
            borderTopRightRadius: radius.sheet,
            maxHeight: "88%",
          }}
        >
          <View
            style={{
              alignSelf: "center",
              width: 36,
              height: 5,
              borderRadius: 3,
              marginTop: 8,
              backgroundColor: colors.b3,
            }}
          />
          <ScrollView
            contentContainerStyle={{
              paddingTop: 16,
              paddingHorizontal: space.page,
              paddingBottom: Math.max(insets.bottom, 16) + 14,
              gap: 12,
            }}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
export function SheetTitle({ text, center }: { text: string; center?: boolean }) {
  const colors = useColors();
  return (
    <Text
      accessibilityRole="header"
      style={[type.sheetTitle, { color: colors.text, textAlign: center ? "center" : "left" }]}
    >
      {text}
    </Text>
  );
}
export function SheetText({
  text,
  center,
  small,
}: {
  text: string;
  center?: boolean;
  small?: boolean;
}) {
  const colors = useColors();
  return (
    <Text
      style={{
        fontSize: small ? 12.5 : 13.5,
        lineHeight: small ? 18 : 20,
        color: colors.text2,
        textAlign: center ? "center" : "left",
      }}
    >
      {text}
    </Text>
  );
}
/** A section title inside a sheet, above its second card. */
export function SheetLabel({ text }: { text: string }) {
  const colors = useColors();
  return (
    <Text
      accessibilityRole="header"
      style={[type.section, { color: colors.text2, paddingHorizontal: 4, paddingTop: 4 }]}
    >
      {text}
    </Text>
  );
}
/** Large rounded icon heading a confirmation sheet (local unlock, YOLO warning). */
export function SheetIcon({ name, tone = "accent" }: { name: IconName; tone?: "accent" | "warn" }) {
  const colors = useColors();
  const warn = tone === "warn";
  return (
    <View
      style={{
        alignSelf: "center",
        width: 72,
        height: 72,
        borderRadius: 20,
        backgroundColor: warn ? colors.warnBg : colors.tert,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Icon name={name} color={warn ? colors.warn : colors.text} size={40} strokeWidth={1.5} />
    </View>
  );
}
export function Radio({ on }: { on: boolean }) {
  const colors = useColors();
  return (
    <View
      style={{
        width: 20,
        height: 20,
        borderRadius: 10,
        borderWidth: on ? 6 : 2,
        borderColor: on ? colors.prim : colors.b3,
      }}
    />
  );
}
/**
 * The desktop settings row: at least 56 high, a title (regular in option lists, `strong` for
 * settings entries), an optional muted line, a leading mark and a value or control at the end.
 */
export function OptionRow({
  title,
  subtitle,
  lead,
  value,
  right,
  onPress,
  disabled,
  mono,
  strong,
  selected,
}: {
  title: string;
  subtitle?: string;
  lead?: ReactNode;
  value?: string;
  right?: ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  mono?: string;
  strong?: boolean;
  selected?: boolean;
}) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityState={{ disabled: !!disabled, selected }}
      disabled={disabled || !onPress}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        minHeight: space.settingsRow,
        paddingVertical: 10,
        paddingHorizontal: 16,
        opacity: disabled ? 0.5 : 1,
        backgroundColor: pressed ? colors.hover : "transparent",
      })}
    >
      {lead}
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text
          style={{
            fontSize: mono ? 14 : 15,
            lineHeight: 20,
            fontWeight: strong ? "600" : "400",
            color: colors.text,
            fontFamily: mono,
          }}
        >
          {title}
        </Text>
        {!!subtitle && <Text style={[type.caption, { color: colors.text2 }]}>{subtitle}</Text>}
      </View>
      {!!value && (
        <Text
          numberOfLines={1}
          style={[type.rowValue, { color: colors.text2, maxWidth: "48%", textAlign: "right" }]}
        >
          {value}
        </Text>
      )}
      {right}
    </Pressable>
  );
}
