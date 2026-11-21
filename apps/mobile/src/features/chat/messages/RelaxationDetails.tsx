import { relaxationText, visibleRelaxations } from "@pibot/client-core";
import type { PlanRelaxation } from "@pibot/protocol";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useSharedText } from "../../../runtime/context.tsx";
import { useColors } from "../../../theme/use-theme.ts";

export function RelaxationDetails({ items }: { items: readonly PlanRelaxation[] }) {
  const t = useSharedText(),
    colors = useColors();
  const [expanded, setExpanded] = useState(false);
  const shown = visibleRelaxations(items, expanded);
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ fontSize: 13, color: colors.warn }}>{t("receipt.relaxation.heading")}</Text>
      {shown.items.map((item, index) => (
        <Text
          // biome-ignore lint/suspicious/noArrayIndexKey: Immutable recorded history may repeat a change across replan rounds.
          key={`${item.stepId}:${item.targetId}:${index}`}
          style={{ fontSize: 13, color: colors.warn }}
        >
          {item.stepTitle ?? item.stepId} · {relaxationText(item, t)}
        </Text>
      ))}
      {items.length > 5 && (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded(!expanded)}
        >
          <Text style={{ color: colors.accent }}>
            {expanded
              ? t("receipt.relaxation.hide")
              : t("receipt.relaxation.more", { count: shown.hidden })}
          </Text>
        </Pressable>
      )}
    </View>
  );
}
