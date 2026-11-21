import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useDisplay } from "../theme/display.tsx";
import { Glass, useGlassTarget } from "../theme/glass.tsx";
import { type } from "../theme/scale.ts";
import { TAB_TINT, type TabName, tintOf } from "../theme/tint.ts";
import { useColors } from "../theme/use-theme.ts";
import { Badge } from "./controls.tsx";
import { Icon, type IconName } from "./icons.tsx";

export interface TabItem {
  name: TabName;
  label: string;
  icon: IconName;
  /** A number shows the violet count; `true` shows the blue unread dot. */
  badge?: number | boolean;
}
// The floating glass capsule, 14 from the screen sides and 12 above the bottom inset.
const BAR = { side: 14, bottom: 12, height: 62, radius: 28 } as const;
/** Bottom padding a tab page leaves so its last row can scroll clear of the floating bar. */
export function useTabBarInset() {
  return BAR.height + BAR.bottom + Math.max(useSafeAreaInsets().bottom, 4) + 12;
}
/**
 * Phone-only bottom tabs: glass over the page (content scrolls beneath it), the chosen tab a
 * brighter glass bubble with its label in the tab's colour.
 */
export function TabBar({
  tabs,
  current,
  onSelect,
}: {
  tabs: TabItem[];
  current: string;
  onSelect: (name: string) => void;
}) {
  const colors = useColors(),
    { scheme } = useDisplay(),
    insets = useSafeAreaInsets(),
    target = useGlassTarget(current);
  return (
    <Glass
      radius={BAR.radius}
      target={target}
      style={{
        position: "absolute",
        left: BAR.side,
        right: BAR.side,
        bottom: BAR.bottom + Math.max(insets.bottom, 4),
        height: BAR.height,
      }}
      innerStyle={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 6 }}
    >
      <View accessibilityRole="tablist" style={{ flex: 1, flexDirection: "row" }}>
        {tabs.map((tab) => {
          const active = tab.name === current;
          const color = active ? tintOf(colors, TAB_TINT[tab.name]).ink : colors.text2;
          const count = typeof tab.badge === "number" ? tab.badge : undefined;
          return (
            <Pressable
              key={tab.name}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={count ? `${tab.label} ${count}` : tab.label}
              onPress={() => onSelect(tab.name)}
              style={{
                flex: 1,
                height: 50,
                borderRadius: 22,
                alignItems: "center",
                justifyContent: "center",
                gap: 1,
                backgroundColor: active ? colors["glass-on"] : "transparent",
                // Android paints a shadow through a translucent bubble; on the dark bar it showed
                // as a clipped box edge, so the dark bubble relies on its brighter fill alone.
                boxShadow: active && scheme === "light" ? colors["shadow-bubble"] : undefined,
              }}
            >
              <View>
                <Icon name={tab.icon} color={color} size={22} strokeWidth={active ? 2 : 1.7} />
                {!!tab.badge && (
                  <Badge
                    count={count}
                    style={count ? { top: -5, left: 15 } : { top: -1, left: 17 }}
                  />
                )}
              </View>
              <Text
                numberOfLines={1}
                style={[type.tab, { color, fontWeight: active ? "700" : "400" }]}
              >
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </Glass>
  );
}
