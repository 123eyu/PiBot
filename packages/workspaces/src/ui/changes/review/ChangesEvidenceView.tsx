import { useComboboxText, useT } from "@pibot/renderer-kit";
import { Button, Combobox, Icon } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import { WorkspaceEvidencePanel as ReviewEvidencePanel } from "../../shell/ports.tsx";
import styles from "./changes-evidence.module.css";

export interface EvidenceScope {
  conversationId: string;
  rootId: string;
  path: string;
  botId?: string;
}

/** Evidence replaces the changes body so historical records cannot consume the file list's height. */
export function ChangesEvidenceView({
  scope,
  members,
  back,
}: {
  scope: EvidenceScope;
  members: readonly { botId: string; name: string }[];
  back(): void;
}) {
  const t = useT();
  const comboboxText = useComboboxText();
  const [selected, select] = useState(scope.botId ?? members[0]?.botId);
  const selectedBot = members.find((member) => member.botId === selected) ?? members[0];
  const backButton = useRef<HTMLButtonElement>(null);
  useEffect(() => backButton.current?.focus({ preventScroll: true }), []);
  return (
    <section className={styles.view} aria-label={t("agentReview.title")}>
      <header className={styles.header}>
        <Button ref={backButton} variant="ghost" className={styles.back} onClick={back}>
          <Icon name="back" size={16} />
          {t("agentWork.backToChanges")}
        </Button>
        <strong>{t("agentReview.title")}</strong>
      </header>
      <div className={styles.scope}>
        <span className={styles.path} title={scope.path}>
          <Icon name="folder" size={14} />
          <span>{scope.path}</span>
        </span>
        {members.length > 1 && selectedBot && (
          <Combobox
            {...comboboxText}
            variant="pill"
            hideLabel
            label={t("group.member")}
            placeholder={t("group.member")}
            value={selectedBot.botId}
            options={members.map((member) => ({ value: member.botId, label: member.name }))}
            onValueChange={select}
          />
        )}
      </div>
      <div className={styles.scroll}>
        {selectedBot && (
          <ReviewEvidencePanel
            botId={selectedBot.botId}
            conversationId={scope.conversationId}
            rootId={scope.rootId}
            expanded
            hideTitle
          />
        )}
      </div>
    </section>
  );
}
