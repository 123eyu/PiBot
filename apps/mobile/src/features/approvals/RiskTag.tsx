import type { Approval } from "@pibot/protocol";
import { Text } from "react-native";
import { useSharedText, useText } from "../../runtime/context.tsx";
import { type } from "../../theme/scale.ts";
import { useColors } from "../../theme/use-theme.ts";
import { StateTag } from "../../ui/controls.tsx";

/** Dangerous requests get the red status dot; others name their kind (write file, run command…). */
export function RiskTag({ approval, long }: { approval: Approval; long?: boolean }) {
  const colors = useColors(),
    t = useText(),
    shared = useSharedText();
  if (approval.risk === "danger")
    return <StateTag kind="fail" label={t(long ? "dangerOp" : "danger")} />;
  return (
    <Text style={[type.caption, { color: colors.text2 }]}>
      {shared(`permissions.category.${approval.category}`)}
    </Text>
  );
}
