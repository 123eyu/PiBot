import type { ExecutionMode } from "@pibot/protocol";
import { useT } from "@pibot/renderer-kit";
import { SegmentedControl } from "@pibot/ui";
import { useExecution } from "../../execution/workspace.tsx";
import styles from "../chat.module.css";

export interface ModeSources {
  draftMode?: ExecutionMode;
  onDraftMode?(mode: ExecutionMode): void;
  botId?: string;
  modeControl?: { mode?: ExecutionMode; ready: boolean; change(mode: ExecutionMode): void };
}

/**
 * Maintainers 2026-11-13: 执行 / 只规划 sits above the composer as a segmented switch instead of inside
 * the send-options menu. Same sources as before: the group's shared mode, the new-topic draft,
 * or each topic's own setting (a group without a shared mode lists its topics by name).
 */
export function ModeSwitch({ draftMode, onDraftMode, botId, modeControl }: ModeSources) {
  const t = useT(),
    workspace = useExecution();
  const topics = botId
    ? workspace?.topics.filter((topic) => topic.botId === botId)
    : workspace?.topics;
  const entries = modeControl
    ? [{ botId: "scope", name: "", mode: modeControl.mode, ready: modeControl.ready }]
    : draftMode
      ? [{ botId: "draft", name: "", mode: draftMode, ready: true }]
      : (topics?.map((topic) => ({
          botId: topic.botId,
          name: topic.name,
          mode: topic.settings?.mode,
          ready: !!topic.settings && !topic.error && !topic.mutating,
        })) ?? []);
  if (!entries.length) return null;
  const change = (topicBotId: string, mode: ExecutionMode) =>
    modeControl
      ? modeControl.change(mode)
      : onDraftMode
        ? onDraftMode(mode)
        : void workspace?.changeMode(topicBotId, mode);
  return (
    <div className={styles.modeSwitch}>
      {entries.map((entry) => (
        <div key={entry.botId} className={styles.modeEntry}>
          {entries.length > 1 && entry.name && (
            <span className={styles.modeName}>{entry.name}</span>
          )}
          <SegmentedControl<ExecutionMode>
            label={entry.name || t("agentWork.messageMode")}
            value={entry.mode ?? "execute"}
            disabled={!entry.ready}
            options={(["execute", "plan"] as const).map((mode) => ({
              value: mode,
              label: t(`execution.${mode}`),
              title: t(
                mode === "plan" ? "agentWork.planDescription" : "agentWork.executeDescription",
              ),
            }))}
            onValueChange={(mode) => change(entry.botId, mode)}
          />
        </div>
      ))}
    </div>
  );
}
