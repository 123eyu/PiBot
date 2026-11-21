import type { MethodResults } from "@pibot/protocol";
import { SettingsSection, useSettings } from "@pibot/renderer-kit";
import { Button, Chip } from "@pibot/ui";
import { MemoryPagination, type useMemoryCursor } from "./MemoryPagination.tsx";
import styles from "./memory-settings.module.css";

export function MemoryUndo({
  data,
  cursor,
  disabled,
  undo,
}: {
  data: MethodResults["memory.browse"];
  cursor: ReturnType<typeof useMemoryCursor>;
  disabled: boolean;
  undo: (proposalId: string) => void;
}) {
  const { t, language } = useSettings();
  return (
    <SettingsSection title={t("memorySettings.undoable")} bare>
      <div className={styles.list} data-memory-undo>
        <p className={styles.meta}>{t("memorySettings.undoNote")}</p>
        {data.undoable.length > 0 && (
          <div className={styles.groupCard}>
            {data.undoable.map((proposal) => (
              <article className={styles.undoRow} key={proposal.id}>
                <Chip>{t(`group.memoryAction.${proposal.action}`)}</Chip>
                <div className={styles.undoText}>
                  <p className={styles.text}>{proposal.text}</p>
                  <p className={styles.meta}>
                    {new Date(proposal.createdAt).toLocaleString(language)}
                  </p>
                </div>
                <Button
                  variant="pill"
                  className={styles.small}
                  disabled={disabled}
                  onClick={() => undo(proposal.id)}
                >
                  {t("memorySettings.undo")}
                </Button>
              </article>
            ))}
          </div>
        )}
        {!data.undoable.length && <p className={styles.meta}>{t("memorySettings.undoEmpty")}</p>}
        <MemoryPagination cursor={cursor} next={data.undoNext} disabled={disabled} />
      </div>
    </SettingsSection>
  );
}
