import { useLocalSearchParams, useRouter } from "expo-router";
import { ScrollView, Text, View } from "react-native";
import { useRuntime, useText } from "../../runtime/context.tsx";
import { useCachedValue } from "../../runtime/use-cached-value.ts";
import { monoFont, useColors } from "../../theme/use-theme.ts";
import { Banner, EmptyState, ErrorLine, ListCard, Separator } from "../../ui/controls.tsx";
import { NavBar } from "../../ui/headers.tsx";
import { Icon } from "../../ui/icons.tsx";
import { OptionRow } from "../../ui/sheet.tsx";
import { type ChangesTarget, diffHref, parseRunParams, readRunTurn, TurnSchema } from "./calls.ts";
import { FileTag, LineCounts } from "./FileTag.tsx";

export function RunChangesScreen() {
  const params = parseRunParams(useLocalSearchParams());
  const router = useRouter(),
    t = useText();
  if (!params)
    return (
      <View style={{ flex: 1 }}>
        <NavBar title="" onBack={() => router.back()} />
        <EmptyState icon="file" title={t("stale")} />
      </View>
    );
  return <RunChanges runId={params.runId} target={params.target} />;
}
/** Files one run changed (read-only); each opens its line diff. */
function RunChanges({ runId, target }: { runId: string; target: ChangesTarget }) {
  const router = useRouter(),
    t = useText(),
    colors = useColors(),
    runtime = useRuntime();
  const turn = useCachedValue(
    `turn:${runId}`,
    TurnSchema,
    (signal) => readRunTurn(runtime, runId, signal),
    ["changes.changed"],
  );
  const files = turn.value?.files ?? [];
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <NavBar
        title={t("changesTitle")}
        subtitle={turn.value ? t("changesCard", { count: turn.value.total }) : undefined}
        onBack={() => router.back()}
      />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {turn.stale && <Banner text={t("fileCachedCopy")} />}
        <ErrorLine text={turn.error && t(turn.error)} />
        {turn.value && !files.length && (
          <Text style={{ color: colors.text2 }}>{t("changesEmpty")}</Text>
        )}
        {!!files.length && (
          <ListCard flush>
            {files.map((file, index) => (
              <View key={file.path}>
                {index > 0 && <Separator />}
                <OptionRow
                  title={file.displayPath}
                  mono={monoFont}
                  lead={<FileTag kind={file.kind} />}
                  subtitle={t(`changeKind_${file.kind}`)}
                  right={
                    <>
                      <LineCounts added={file.added} removed={file.removed} />
                      <Icon name="chevronRight" color={colors.text2} size={16} />
                    </>
                  }
                  onPress={() => router.push(diffHref(runId, target, file))}
                />
              </View>
            ))}
          </ListCard>
        )}
        {turn.value?.truncated && <Banner text={t("changesTruncated")} />}
      </ScrollView>
    </View>
  );
}
