import { Text, View } from "react-native";
import { monoFont, useColors } from "../../theme/use-theme.ts";

type Kind = "add" | "modify" | "delete" | "command";
/** The desktop changes panel's A / M / D tag: green added, red deleted, blue otherwise. */
export function FileTag({ kind }: { kind: Kind }) {
  const colors = useColors();
  const [letter, fg, bg] =
    kind === "add"
      ? ["A", colors.ok, colors.okBg]
      : kind === "delete"
        ? ["D", colors.danger, colors.dangerBg]
        : ["M", colors.accent, colors.accentBg];
  return (
    <View
      style={{
        minWidth: 20,
        height: 18,
        paddingHorizontal: 3,
        borderRadius: 5,
        backgroundColor: bg,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ fontSize: 11, fontWeight: "700", color: fg }}>{letter}</Text>
    </View>
  );
}
/** "+3 −1" in the diff colours, tabular monospace; unknown counts are left out. */
export function LineCounts({ added, removed }: { added: number | null; removed: number | null }) {
  const colors = useColors();
  const font = { fontFamily: monoFont, fontSize: 12.5, fontVariant: ["tabular-nums" as const] };
  return (
    <View style={{ flexDirection: "row", gap: 6 }}>
      {added !== null && <Text style={[font, { color: colors.ok }]}>+{added}</Text>}
      {removed !== null && <Text style={[font, { color: colors.danger }]}>−{removed}</Text>}
    </View>
  );
}
