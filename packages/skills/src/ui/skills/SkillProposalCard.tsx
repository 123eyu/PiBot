import { useAction, useNavigation, useRpc, useT } from "@pibot/renderer-kit";
import type { SkillDocument, SkillFileChange, SkillProposal } from "@pibot/skills-contract/full";
import { Button, Icon } from "@pibot/ui";
import { useState } from "react";
import { skillError } from "./presentation.ts";
import { SkillEditor } from "./SkillEditor.tsx";
import styles from "./skills.module.css";

/** `skill_propose` confirmation card: nothing is saved until the user accepts. */
export function SkillProposalCard({
  proposal,
  botName,
  changed,
}: {
  proposal: SkillProposal;
  botName: string;
  changed(next: SkillProposal): void;
}) {
  const t = useT();
  const { peer } = useRpc();
  const { openBotPanel } = useNavigation();
  const task = useAction();
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState<SkillDocument>();
  const document = edited ?? proposal.payload;
  const resolve = async (accept: boolean, edits?: SkillDocument, files?: SkillFileChange[]) => {
    if (!peer) return;
    const result = await task.run(
      () =>
        peer.call("skills.propose.resolve", {
          proposalId: proposal.id,
          accept,
          ...(edits ? { edits } : {}),
          ...(files ? { files } : {}),
        }),
      skillError,
    );
    if (result && result.proposal.id === proposal.id) {
      setEditing(false);
      changed(result.proposal);
    }
  };
  const open = proposal.status === "open";
  return (
    <section className={styles.card} aria-label={t("skills.proposal.title", { bot: botName })}>
      <div className={styles.cardHead}>
        <Icon name="puzzle" size={16} />
        <span>{t("skills.proposal.title", { bot: botName })}</span>
      </div>
      <p className={styles.cardSub}>
        「{document.name}」· {document.description}
      </p>
      {editing ? (
        <div className={styles.cardBody}>
          <SkillEditor
            initial={document}
            scope={{ botId: proposal.botId }}
            botName={botName}
            busy={task.busy}
            submitLabel={t("skills.proposal.accept")}
            onCancel={() => setEditing(false)}
            onSubmit={(next, files) => {
              setEdited(next);
              void resolve(true, next, files);
            }}
          />
        </div>
      ) : (
        <div className={styles.cardBody}>
          {document.params.length > 0 && (
            <p className={styles.kv}>
              <span>{t("skills.detail.params")}</span>
              <span>
                {document.params
                  .map((p) =>
                    p.default
                      ? `${p.name} (${t("skills.detail.default", { value: p.default })})`
                      : p.name,
                  )
                  .join(" · ")}
              </span>
            </p>
          )}
          <details>
            <summary>{t("skills.proposal.steps")}</summary>
            <pre className={styles.body}>{document.body}</pre>
          </details>
        </div>
      )}
      {open && !editing && (
        <div className={styles.cardActions}>
          <Button variant="ghost" disabled={task.busy || !peer} onClick={() => resolve(false)}>
            {t("skills.proposal.decline")}
          </Button>
          <Button
            variant="secondary"
            disabled={task.busy || !peer}
            onClick={() => setEditing(true)}
          >
            {t("skills.edit")}
          </Button>
          <Button
            variant="primary"
            loading={task.busy}
            disabled={!peer}
            onClick={() => resolve(true, edited)}
          >
            {t("skills.proposal.accept")}
          </Button>
        </div>
      )}
      {!open && (
        <div className={styles.cardResult} data-accepted={proposal.status === "accepted"}>
          {proposal.status === "accepted" && <Icon name="check" size={16} />}
          <span className={styles.grow}>
            {proposal.status === "accepted"
              ? t("skills.proposal.accepted", { name: document.name })
              : t(
                  proposal.status === "declined"
                    ? "skills.proposal.declined"
                    : "skills.proposal.expired",
                )}
          </span>
          {proposal.status === "accepted" && (
            <Button
              variant="secondary"
              className={styles.mini}
              onClick={() => openBotPanel(proposal.botId, "memory")}
            >
              {t("skills.proposal.view")}
            </Button>
          )}
        </div>
      )}
      {task.error && (
        <p role="alert" className={`${styles.error} ${styles.cardSub}`}>
          {t(task.error)}
        </p>
      )}
    </section>
  );
}
