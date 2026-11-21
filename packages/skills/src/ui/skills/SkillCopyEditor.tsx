import type { TranslationKey } from "@pibot/i18n";
import { useAction, useRpc, useT, useWorkspace } from "@pibot/renderer-kit";
import type { SkillDocument, SkillPackageFile } from "@pibot/skills-contract/full";
import { Button } from "@pibot/ui";
import { useCallback, useEffect, useState } from "react";
import { skillError } from "./presentation.ts";
import { SkillEditor } from "./SkillEditor.tsx";
import styles from "./skills.module.css";
import { useSkillUpdate } from "./use-skill-update.ts";

/**
 * The connections page's 「编辑」 for one catalog row: the same package editor as the skill's
 * details, on the row's representative copy. The page owns the drawer and says which copy it is.
 */
export function SkillCopyEditor({
  skillId,
  groupId,
  botId,
  busy,
  close,
  saved,
}: {
  skillId: string;
  groupId?: string;
  botId: string;
  busy(value: boolean): void;
  close(): void;
  saved(): void;
}) {
  const t = useT();
  const { peer } = useRpc();
  const { bots } = useWorkspace();
  const task = useAction();
  const update = useSkillUpdate(task, skillId, groupId);
  const [data, setData] = useState<{
    document: SkillDocument;
    files: (SkillPackageFile & { text?: boolean })[];
  }>();
  const [loadError, setLoadError] = useState<TranslationKey>();
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision((n) => n + 1), []);
  useEffect(() => busy(task.busy), [busy, task.busy]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Revision requests a fresh read.
  useEffect(() => {
    if (!peer) return;
    const controller = new AbortController();
    setLoadError(undefined);
    void peer
      .call("skills.get", { groupId, skillId }, { signal: controller.signal })
      .then((result) => {
        // The row may have been regrouped since it was listed; never edit another Bot's skill.
        if (result.skill.id !== skillId || result.skill.botId !== botId)
          throw new Error("Skill owner changed");
        setData({ document: result.document, files: result.files });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoadError(skillError(error));
      });
    return () => controller.abort();
  }, [peer, skillId, botId, groupId, revision]);
  if (loadError)
    return (
      <p role="alert" className={styles.error}>
        {t(loadError)}{" "}
        <Button variant="pill" onClick={retry}>
          {t("common.retry")}
        </Button>
      </p>
    );
  if (!data)
    return (
      <p role="status" className={styles.note}>
        {t("common.loading")}
      </p>
    );
  return (
    <SkillEditor
      initial={data.document}
      files={data.files}
      scope={{ botId, groupId, skillId }}
      botName={bots.find((bot) => bot.id === botId)?.name ?? "Pi"}
      busy={task.busy}
      onCancel={close}
      onSubmit={async (next, files) => {
        if (await update(next, files)) saved();
      }}
    >
      {task.error && (
        <p role="alert" className={styles.error}>
          {t(task.error)}
        </p>
      )}
    </SkillEditor>
  );
}
