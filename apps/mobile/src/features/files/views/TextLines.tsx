import { useMemo } from "react";
import { FlatList, ScrollView, Text, View } from "react-native";
import { monoFont, useColors } from "../../../theme/use-theme.ts";

// Very long lines (minified files) would make one enormous native text view.
const LINE_CHARS = 2_000;
/** Read-only code / plain text: numbered lines in a virtualized list, scrolling sideways. */
export function TextLines({ text }: { text: string }) {
  const colors = useColors();
  const lines = useMemo(() => {
    const rows = text.split("\n");
    if (rows.at(-1) === "") rows.pop();
    return rows;
  }, [text]);
  const gutter = String(lines.length).length * 8 + 12;
  return (
    <ScrollView horizontal style={{ flex: 1 }} contentContainerStyle={{ minWidth: "100%" }}>
      <FlatList
        data={lines}
        keyExtractor={(_, index) => String(index)}
        initialNumToRender={60}
        windowSize={11}
        contentContainerStyle={{ paddingVertical: 10, paddingRight: 16 }}
        renderItem={({ item, index }) => (
          <View style={{ flexDirection: "row" }}>
            <Text
              style={{
                width: gutter,
                textAlign: "right",
                paddingRight: 10,
                fontFamily: monoFont,
                fontSize: 12,
                lineHeight: 19,
                color: colors.text2,
              }}
            >
              {index + 1}
            </Text>
            <Text
              selectable
              style={{ fontFamily: monoFont, fontSize: 12.5, lineHeight: 19, color: colors.text }}
            >
              {item.length > LINE_CHARS ? `${item.slice(0, LINE_CHARS)}…` : item || " "}
            </Text>
          </View>
        )}
      />
    </ScrollView>
  );
}
