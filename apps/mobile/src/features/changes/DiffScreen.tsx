import { useLocalSearchParams, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { useRuntime, useText } from "../../runtime/context.tsx";
import { useAction } from "../../runtime/use-action.ts";
import { useCachedValue } from "../../runtime/use-cached-value.ts";
import { monoFont, useColors } from "../../theme/use-theme.ts";
import { Banner, Button, EmptyState, ErrorLine } from "../../ui/controls.tsx";
import { NavBar } from "../../ui/headers.tsx";
import { fileHref } from "../files/source.ts";
import { DiffSchema, parseDiffParams, readTurnDiff, readTurnLines } from "./calls.ts";
import { type DiffRow, diffRows, type Expanded } from "./diff-rows.ts";
import { LineCounts } from "./FileTag.tsx";

export function DiffScreen() {
  const params = parseDiffParams(useLocalSearchParams());
  const router = useRouter(),
    t = useText();
  if (!params)
    return (
      <View style={{ flex: 1 }}>
        <NavBar title="" onBack={() => router.back()} />
        <EmptyState icon="file" title={t("stale")} />
      </View>
    );
  return <Diff {...params} />;
}
const LINE_CHARS = 2_000;
const font = { fontFamily: monoFont, fontSize: 12.5, lineHeight: 20 };
/** One unified-diff line: old and new numbers, the sign, then the text wrapped by character. */
function Line({ row }: { row: Extract<DiffRow, { type: "line" }> }) {
  const colors = useColors();
  const bg = row.sign === "+" ? colors.okBg : row.sign === "-" ? colors.dangerBg : undefined;
  const sign = row.sign === "+" ? colors.ok : row.sign === "-" ? colors.danger : colors.text2;
  // 30pt in the design; widened so four-digit line numbers still fit the monospace face.
  const number = {
    width: 36,
    textAlign: "right" as const,
    paddingRight: 6,
    color: colors.text2,
    fontVariant: ["tabular-nums" as const],
  };
  return (
    <View style={{ flexDirection: "row", paddingRight: 12, backgroundColor: bg }}>
      <Text style={[font, number]}>{row.oldNo ?? ""}</Text>
      <Text style={[font, number]}>{row.newNo ?? ""}</Text>
      <Text style={[font, { width: 14, color: sign }]}>{row.sign === " " ? "" : row.sign}</Text>
      <Text
        selectable
        style={[font, { flex: 1, color: row.sign === "\\" ? colors.text2 : colors.text }]}
      >
        {row.text.length > LINE_CHARS ? `${row.text.slice(0, LINE_CHARS)}…` : row.text}
      </Text>
    </View>
  );
}
/** Read-only line diff of one file of one run, from the run's recorded snapshots. */
function Diff(props: NonNullable<ReturnType<typeof parseDiffParams>>) {
  const { runId, path, name, previewable, target } = props;
  const router = useRouter(),
    t = useText(),
    colors = useColors(),
    runtime = useRuntime();
  const diff = useCachedValue(`diff:${runId}:${path}`, DiffSchema, (signal) =>
    readTurnDiff(runtime, target, runId, path, signal),
  );
  const [expanded, setExpanded] = useState<Expanded>({});
  const lines = useAction(`lines:${runId}:${path}`);
  const rows = useMemo(
    () => (diff.value ? diffRows(diff.value, expanded) : []),
    [diff.value, expanded],
  );
  const expand = (from: number, count: number) =>
    lines.run(async (signal) => {
      const result = await readTurnLines(runtime, { target, runId, path, from, count }, signal);
      if (result.lines.length) setExpanded((current) => ({ ...current, [from]: result.lines }));
    });
  const value = diff.value;
  const note = !value
    ? undefined
    : value.unavailable
      ? t(value.unavailable === "command" ? "diffCommand" : "diffSnapshotMissing")
      : value.binary
        ? t("diffBinary")
        : value.tooLarge
          ? t("diffTooLarge")
          : !value.hunks.length
            ? t("diffEmpty")
            : undefined;
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <NavBar
        title={name.split("/").pop() || name}
        subtitle={name}
        mono={monoFont}
        onBack={() => router.back()}
      />
      <View
        style={{
          marginTop: 12,
          marginHorizontal: 16,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        {value && <LineCounts added={value.added} removed={value.removed} />}
        <View style={{ flex: 1 }} />
        {previewable && (
          <Button
            icon="file"
            title={t("diffOpenFile")}
            onPress={() => router.push(fileHref({ runId, path }, name))}
          />
        )}
      </View>
      {(diff.stale || !!note) && (
        <View style={{ paddingHorizontal: 16, paddingTop: 10, gap: 8 }}>
          {diff.stale && <Banner text={t("fileCachedCopy")} />}
          {!!note && <Banner text={note} />}
        </View>
      )}
      <ErrorLine text={(diff.error && t(diff.error)) || (lines.error && t(lines.error))} />
      {!value && !diff.error && <EmptyState icon="file" title={t("fileLoading")} />}
      {/* One unified column that wraps by character: the desktop's side-by-side does not fit. */}
      <FlatList
        style={{ flex: 1, marginTop: 10, borderTopWidth: 1, borderTopColor: colors.b1 }}
        data={rows}
        keyExtractor={(row) => row.key}
        initialNumToRender={60}
        windowSize={11}
        contentContainerStyle={{ paddingBottom: 16 }}
        renderItem={({ item }) =>
          item.type === "line" ? (
            <Line row={item} />
          ) : item.type === "hunk" ? (
            <Text
              style={{
                marginTop: 8,
                marginHorizontal: 12,
                marginBottom: 4,
                paddingHorizontal: 8,
                paddingVertical: 2,
                borderRadius: 8,
                overflow: "hidden",
                fontSize: 12,
                lineHeight: 24,
                color: colors.accent,
                backgroundColor: colors.accentBg,
              }}
            >
              {item.text}
            </Text>
          ) : (
            <Pressable
              accessibilityRole="button"
              disabled={!diff.online || lines.busy}
              onPress={() => void expand(item.from, item.count)}
              style={({ pressed }) => ({
                marginVertical: 4,
                marginHorizontal: 12,
                minHeight: 36,
                justifyContent: "center",
                paddingHorizontal: 10,
                borderRadius: 8,
                backgroundColor: pressed ? colors.hover : colors.tert,
                opacity: diff.online ? 1 : 0.5,
              })}
            >
              <Text style={{ fontSize: 12, color: colors.text2 }}>
                {t("diffExpand", { count: item.count })}
              </Text>
            </Pressable>
          )
        }
      />
    </View>
  );
}
