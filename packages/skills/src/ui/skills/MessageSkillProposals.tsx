import { useRpc, useRpcEvent, useT } from "@pibot/renderer-kit";
import type { SkillProposal } from "@pibot/skills-contract/full";
import { Button } from "@pibot/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { SkillProposalCard } from "./SkillProposalCard.tsx";
import styles from "./skills.module.css";

/** Cards for the `skill_propose` calls of one assistant message (at most 20 per Bot are open). */
export function MessageSkillProposals({
  botId,
  botName,
  messageId,
}: {
  botId: string;
  botName: string;
  messageId: string;
}) {
  const t = useT();
  const { peer } = useRpc();
  const [rows, setRows] = useState<SkillProposal[]>([]);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const reload = useCallback(() => setRevision((n) => n + 1), []);
  useRpcEvent("skills.changed", (event) => {
    if (event.botId !== botId || event.messageId !== messageId) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(reload, 150);
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: Revision requests a fresh read.
  useEffect(() => {
    if (!peer) return;
    let active = true;
    setFailed(false);
    void peer
      .call("skills.proposals", { botId, messageId, limit: 20 })
      .then((list) => {
        if (!active) return;
        if (list.some((p) => p.botId !== botId || p.messageId !== messageId))
          throw new Error("Proposal owner changed");
        // Oldest first, in the order the Bot proposed them.
        setRows([...list].reverse());
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [peer, botId, messageId, revision]);
  return (
    <>
      {rows.map((proposal) => (
        <SkillProposalCard
          key={proposal.id}
          proposal={proposal}
          botName={botName}
          changed={(next) =>
            setRows((list) => list.map((row) => (row.id === next.id ? next : row)))
          }
        />
      ))}
      {failed && (
        <p role="alert" className={styles.error}>
          {t("skills.error.failed")}{" "}
          <Button variant="pill" onClick={reload}>
            {t("common.retry")}
          </Button>
        </p>
      )}
    </>
  );
}
