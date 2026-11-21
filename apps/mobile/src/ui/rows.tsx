import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { IconDot } from "../theme/icon-dot.tsx";
import { space, type } from "../theme/scale.ts";
import { useColors } from "../theme/use-theme.ts";
import { Icon, type IconName } from "./icons.tsx";

/**
 * The settings row: an optional coloured icon dot, a bold title and one muted line, then one
 * thing on the right (switch, pill or value). With `onPress` the row opens a page and ends with
 * the right arrow.
 */
export function SettingRow({
  icon,
  tint,
  lead,
  title,
  hint,
  hintTone,
  titleTone,
  right,
  onPress,
  disabled,
  chevron = true,
}: {
  icon?: IconName;
  /** Avatar colour name for the icon dot. */
  tint?: string;
  /** Replaces the icon dot (an avatar, a device tile). */
  lead?: ReactNode;
  title: string;
  hint?: string;
  hintTone?: "warn" | "danger";
  titleTone?: "danger" | "accent";
  right?: ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  /** An action row (e.g. Unpair) does its thing in place and has no arrow. */
  chevron?: boolean;
}) {
  const colors = useColors();
  const hintColor =
    hintTone === "warn" ? colors.warn : hintTone === "danger" ? colors.danger : colors.text2;
  const titleColor =
    titleTone === "danger" ? colors.danger : titleTone === "accent" ? colors.accent : colors.text;
  const body = (pressed: boolean) => (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        minHeight: space.settingsRow,
        paddingVertical: 10,
        paddingHorizontal: 14,
        backgroundColor: pressed ? colors.hover : "transparent",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {lead ?? (icon && <IconDot icon={icon} tint={tint ?? "violet"} />)}
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text style={[type.rowTitle, { color: titleColor }]}>{title}</Text>
        {!!hint && <Text style={[type.caption, { color: hintColor }]}>{hint}</Text>}
      </View>
      {right}
      {onPress && chevron && <Icon name="chevronRight" color={colors.text2} size={16} />}
    </View>
  );
  if (!onPress) return body(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={hint ? `${title}, ${hint}` : title}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
    >
      {({ pressed }) => body(pressed)}
    </Pressable>
  );
}
