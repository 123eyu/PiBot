import type { Message } from "@pibot/protocol";
import { useRouter } from "expo-router";
import type { ReactNode } from "react";
import { Pressable, Text } from "react-native";
import { useRuntime, useText } from "../../../runtime/context.tsx";
import { useCachedValue } from "../../../runtime/use-cached-value.ts";
import { monoFont, useColors } from "../../../theme/use-theme.ts";
import {
  type ChangesTarget,
  diffHref,
  readRunTurn,
  runChangesHref,
  TurnSchema,
} from "../../changes/calls.ts";
import { FileTag, LineCounts } from "../../changes/FileTag.tsx";
import { ChangesCard } from "./cards.tsx";

// The same tools as the desktop TurnCard: only a reply that could have written files asks.
// The card lists a few files; the rest are one tap away in the run's changes page.
const SHOWN_FILES = 4;
const WRITING_TOOLS = new Set(["write_file", "edit_file", "run_command"]);
export function wroteFiles(message: Message): message is Message & { runId: string } {
  return (
    message.role === "assistant" &&
    message.status !== "streaming" &&
    !!message.runId &&
    !!message.tools?.some((tool) => WRITING_TOOLS.has(tool.tool))
  );
}
/**
 * "This turn changed N files" right under the reply of that run, as on the desktop. `footer`
 * (the work receipt) closes the card; without changed files `fallback` shows on its own instead.
 */
export function RunChangesCard({
  runId,
  target,
  footer,
  fallback,
}: {
  runId: string;
  target: ChangesTarget;
  footer?: ReactNode;
  fallback?: ReactNode;
}) {
  const runtime = useRuntime(),
    router = useRouter(),
    colors = useColors(),
    t = useText();
  // Cached per run, so the card also shows offline and opens without a blank first frame.
  const turn = useCachedValue(
    `turn:${runId}`,
    TurnSchema,
    (signal) => readRunTurn(runtime, runId, signal),
    ["changes.changed"],
  );
  const files = turn.value?.files ?? [];
  // Wait for the first answer before choosing card or fallback, so the receipt does not jump.
  if (!turn.value && turn.busy) return null;
  if (!files.length) return fallback ?? null;
  const shown = files.slice(0, SHOWN_FILES),
    more = files.length - shown.length;
  const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0);
  const removed = files.reduce((sum, file) => sum + (file.removed ?? 0), 0);
  return (
    <ChangesCard
      title={t("changesCard", { count: files.length })}
      counts={<LineCounts added={added} removed={removed} />}
      onPress={() => router.push(runChangesHref(runId, target))}
    >
      {shown.map((file, index) => (
        <Pressable
          key={file.path}
          accessibilityRole="button"
          onPress={() => router.push(diffHref(runId, target, file))}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            minHeight: 36,
            paddingTop: 4,
            paddingHorizontal: 14,
            paddingBottom: index === shown.length - 1 && !more ? 10 : 4,
            backgroundColor: pressed ? colors.hover : "transparent",
          })}
        >
          <FileTag kind={file.kind} />
          <Text
            numberOfLines={1}
            style={{ flex: 1, minWidth: 0, fontFamily: monoFont, fontSize: 13, color: colors.text }}
          >
            {file.displayPath}
          </Text>
          <LineCounts added={file.added} removed={file.removed} />
        </Pressable>
      ))}
      {more > 0 && (
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push(runChangesHref(runId, target))}
          style={({ pressed }) => ({
            minHeight: 36,
            justifyContent: "center",
            paddingTop: 4,
            paddingHorizontal: 14,
            paddingBottom: 10,
            backgroundColor: pressed ? colors.hover : "transparent",
          })}
        >
          <Text style={{ fontSize: 13, color: colors.accent }}>
            {t("changesMore", { count: more })}
          </Text>
        </Pressable>
      )}
      {footer}
    </ChangesCard>
  );
}
