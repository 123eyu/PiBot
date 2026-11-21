import type { ChatPeer } from "@pibot/client-core";
import type { ExecutionSettings, Group, MethodResults } from "@pibot/protocol";
import { useT } from "@pibot/renderer-kit";
import { Button, Chip } from "@pibot/ui";
import { useEffect, useState } from "react";
import { BudgetEditor } from "../execution/BudgetEditor.tsx";
import styles from "./group.module.css";

/**
 * The group's shared run limits (cost cap included), edited in「群设置」next to the round limit.
 * It used to sit at the bottom of the task pane, which is unreachable while the group has no
 * tasks (maintainers 2026-10-22).
 */
export function GroupLimits({ peer, group }: { peer: ChatPeer; group: Group }) {
  const t = useT();
  const [revision, refresh] = useState(0);
  const [value, setValue] = useState<{
    groupId: string;
    settings?: MethodResults["groups.execution.get"];
    error: boolean;
  }>();
  useEffect(
    () =>
      peer.on("groups.execution.changed", (event) => {
        if (event.groupId === group.id) refresh((v) => v + 1);
      }),
    [peer, group.id],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` re-reads after a change event.
  useEffect(() => {
    const controller = new AbortController();
    peer
      .call(
        "groups.execution.get",
        { groupId: group.id },
        { signal: controller.signal, timeoutMs: 10000 },
      )
      .then(
        (settings) => {
          if (!controller.signal.aborted) setValue({ groupId: group.id, settings, error: false });
        },
        () => {
          if (!controller.signal.aborted)
            setValue((old) => ({
              groupId: group.id,
              ...(old?.groupId === group.id ? { settings: old.settings } : {}),
              error: true,
            }));
        },
      );
    return () => controller.abort();
  }, [peer, group.id, revision]);
  const [saved, setSaved] = useState(false);
  // Autosave confirmation: a brief tag, not a line that stays.
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2500);
    return () => clearTimeout(timer);
  }, [saved]);
  const current = value?.groupId === group.id ? value : undefined;
  const settings = current?.settings;
  const editor: ExecutionSettings | undefined = settings
    ? {
        botId: group.coordinatorBotId,
        conversationId: group.conversationId,
        mode: settings.mode,
        limits: settings.limits,
        version: settings.version,
        updatedAt: settings.updatedAt,
      }
    : undefined;
  return (
    <>
      {current?.error && (
        <p role="alert" className={styles.error}>
          {t("execution.loadError")}{" "}
          <Button variant="ghost" onClick={() => refresh((v) => v + 1)}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {saved && (
        <Chip tone="ok" role="status">
          {t("workspace.saved")}
        </Chip>
      )}
      {editor && settings && (
        <BudgetEditor
          key={group.id}
          settings={editor}
          hint={t("group.sharedRunLimitsHint")}
          accept={() => {
            setSaved(true);
            refresh((v) => v + 1);
          }}
          persist={async (limits, signal) => {
            const updated = await peer.call(
              "groups.execution.set",
              { groupId: group.id, expectedVersion: settings.version, limits },
              { signal, timeoutMs: 10000 },
            );
            return {
              ...editor,
              limits: updated.limits,
              version: updated.version,
              updatedAt: updated.updatedAt,
            };
          }}
        />
      )}
    </>
  );
}
