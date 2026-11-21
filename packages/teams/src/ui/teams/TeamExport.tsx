import type { TranslationKey } from "@pibot/i18n";
import {
  type MethodParams,
  RpcError,
  RpcErrorCodes,
  type TeamSkillReimport,
} from "@pibot/protocol";
import { Overlay, useRpc, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import { TeamSourceSkill } from "./TeamSourceSkill.tsx";
import styles from "./teams.module.css";

export function TeamExport({
  target,
  close,
}: {
  target: MethodParams["teams.export"];
  close(): void;
}) {
  const { peer } = useRpc();
  const t = useT();
  const life = useRef({ active: true, pending: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TranslationKey>();
  const [omitted, setOmitted] = useState<TeamSkillReimport[]>([]);
  const [saved, setSaved] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  useEffect(() => {
    const current = { active: true, pending: false };
    life.current = current;
    setBusy(false);
    setError(undefined);
    setSaved(false);
    setOmitted([]);
    setCancelled(false);
    return () => {
      current.active = false;
      if (current.pending && peer)
        void peer.call("teams.cancel", {}).catch(() => {
          // Brain stop invalidates any late native selection if the peer already closed.
        });
    };
  }, [peer]);
  const save = async () => {
    const current = life.current;
    if (!peer || current.pending || error === "workspace.actionUncertain") return;
    current.pending = true;
    setBusy(true);
    setError(undefined);
    setSaved(false);
    setOmitted([]);
    setCancelled(false);
    try {
      const result = await peer.call("teams.export", target, { timeoutMs: 720_000 });
      if (current.active) {
        setSaved(result.saved);
        setOmitted(result.saved ? (result.omitted ?? []) : []);
        setCancelled(!result.saved);
      }
    } catch (error) {
      if (current.active)
        setError(
          error instanceof RpcError &&
            (error.code === RpcErrorCodes.timeout || error.code === RpcErrorCodes.closed)
            ? "workspace.actionUncertain"
            : error instanceof RpcError && error.message === "team_too_large"
              ? "teams.tooLarge"
              : "teams.exportFailed",
        );
    } finally {
      current.pending = false;
      if (current.active) setBusy(false);
    }
  };
  return (
    <Overlay icon="send" tone="blue" title={t("workspace.share")} close={close}>
      <p className={styles.note}>
        {t(target.groupId ? "teams.exportNote" : "teams.exportBotNote")}
      </p>
      <Button
        className={styles.primary}
        loading={busy}
        disabled={!peer || busy || error === "workspace.actionUncertain"}
        onClick={() => void save()}
      >
        {t("common.save")}
      </Button>
      {saved && (
        <p role="status" className={styles.note}>
          {t("workspace.saved")}
        </p>
      )}
      {omitted.map((skill, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Immutable export receipt; different Bots may share a folder and digest.
        <TeamSourceSkill key={`${index}:${skill.folder}`} skill={skill} />
      ))}
      {cancelled && (
        <p role="status" className={styles.note}>
          {t("teams.saveCancelled")}
        </p>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {t(error)}
        </p>
      )}
    </Overlay>
  );
}
