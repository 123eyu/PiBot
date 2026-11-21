import { useAction, useRpc, useT, useWorkspace } from "@pibot/renderer-kit";
import type { SkillDocument, SkillFileChange } from "@pibot/skills-contract/full";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { skillError } from "./presentation.ts";
import { SkillEditor } from "./SkillEditor.tsx";
import styles from "./skills.module.css";

/**
 * 「写一个技能」 on the connections page: the first chosen Bot gets the skill as its own, the others a
 * copy through the catalog, exactly as if it were given to them from the skill's details later.
 * With nobody chosen it is kept, switched off, under the main Bot — like a skill brought over from
 * another tool, the list offers 「给 Bot 用」 for it.
 */
export function SkillWriter({
  botIds,
  audience,
  busy,
  close,
}: {
  botIds: readonly string[];
  audience: ReactNode;
  busy(value: boolean): void;
  close(): void;
}) {
  const t = useT();
  const { peer } = useRpc();
  const { bots } = useWorkspace();
  const task = useAction();
  // A retry of the same document for the same Bot reuses the request id, so a create that landed
  // before a copy failed is not refused as a duplicate name.
  const attempt = useRef<{ key: string; requestId: string } | undefined>(undefined);
  const [copyFailed, setCopyFailed] = useState<{ saved: string; bot: string }>();
  useEffect(() => busy(task.busy), [busy, task.busy]);
  const botName = (id: string | undefined) => bots.find((bot) => bot.id === id)?.name ?? "Pi";
  const active = bots.filter((bot) => !bot.archivedAt);
  const keeper = (active.find((bot) => bot.isMain) ?? active[0])?.id;
  const save = async (document: SkillDocument, files?: SkillFileChange[]) => {
    const [chosen, ...others] = botIds;
    const owner = chosen ?? keeper;
    const enabled = chosen !== undefined;
    if (!peer) return;
    setCopyFailed(undefined);
    if (!owner) {
      task.setError("skills.write.noBots");
      return;
    }
    const key = JSON.stringify({ owner, enabled, document, files });
    const current =
      attempt.current?.key === key ? attempt.current : { key, requestId: crypto.randomUUID() };
    attempt.current = current;
    const saved = await task.run(async (signal) => {
      const skill = await peer.call(
        "skills.create",
        {
          requestId: current.requestId,
          botId: owner,
          document,
          enabled,
          ...(files ? { files } : {}),
        },
        { signal },
      );
      for (const botId of others) {
        try {
          await peer.call(
            "skills.catalogAssign",
            { skillId: skill.id, botId, enabled: true },
            { signal },
          );
        } catch (error) {
          setCopyFailed({ saved: botName(owner), bot: botName(botId) });
          throw error;
        }
      }
      return skill;
    }, skillError);
    if (saved) {
      attempt.current = undefined;
      close();
    }
  };
  return (
    <SkillEditor
      // Uploads are kept by the private skill store, which every chosen Bot saves through.
      scope={{ botId: botIds[0] ?? keeper }}
      botName={botName(botIds[0] ?? keeper)}
      busy={task.busy}
      onCancel={close}
      onSubmit={(document, files) => void save(document, files)}
    >
      {audience}
      {task.error && (
        <p role="alert" className={styles.error}>
          {copyFailed && `${t("skills.write.copyFailed", copyFailed)} `}
          {t(task.error)}
        </p>
      )}
    </SkillEditor>
  );
}
