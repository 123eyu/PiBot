import { Text, View } from "react-native";
import { space, type } from "../theme/scale.ts";
import { useColors } from "../theme/use-theme.ts";

export interface Stat {
  label: string;
  value: number;
  /** Drawn in the warning colour: something waits for the user. */
  warn?: boolean;
}
/** Three-up summary on a tab's colour wash: frosted tiles, a big number, a short label. */
export function StatRow({ stats }: { stats: Stat[] }) {
  const colors = useColors();
  return (
    <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: space.page, paddingTop: 10 }}>
      {stats.map((stat) => (
        <View
          key={stat.label}
          accessible
          accessibilityLabel={`${stat.label} ${stat.value}`}
          style={{
            flex: 1,
            borderRadius: 16,
            paddingVertical: 9,
            paddingHorizontal: 11,
            backgroundColor: colors["wash-pill"],
          }}
        >
          <Text
            style={[
              type.stat,
              { color: stat.warn && stat.value > 0 ? colors.warn : colors.text },
              { fontVariant: ["tabular-nums"] },
            ]}
          >
            {stat.value}
          </Text>
          <Text numberOfLines={1} style={[type.small, { color: colors.text2 }]}>
            {stat.label}
          </Text>
        </View>
      ))}
    </View>
  );
}
