import { View } from "react-native";
import { Icon, type IconName } from "../ui/icons.tsx";
import { tintOf } from "./tint.ts";
import { useColors } from "./use-theme.ts";

/**
 * Row icon: a line icon from the desktop set in white on a round fill of the Bot avatar
 * palette. Gray and ink use the deepened fill so the white glyph still reads.
 */
export function IconDot({
  icon,
  tint,
  size = 32,
}: {
  icon: IconName;
  /** An avatar colour name ("teal", "amber", …). */
  tint: string;
  size?: number;
}) {
  const colors = useColors();
  const tone = tintOf(colors, tint);
  const deep = tint === "gray" || tint === "ink";
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: deep ? tone.fill : tone.wash,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Icon name={icon} color={colors["avatar-eye"]} size={Math.round(size * 0.56)} />
    </View>
  );
}
