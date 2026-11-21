import type { TranslationKey } from "@pibot/i18n";
import {
  type TeamPreview as Preview,
  RpcError,
  RpcErrorCodes,
  type TeamSkillReimport,
} from "@pibot/protocol";
import { Overlay, useNavigation, useRpc, useT, useWorkspace } from "@pibot/renderer-kit";
import { Button, Icon, IconTile } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import { TeamPreview } from "./TeamPreview.tsx";
import { TeamSourceSkill } from "./TeamSourceSkill.tsx";
import styles from "./teams.module.css";

export function TeamImport({ close }: { close(): void }) {
  const { peer } = useRpc();
  const t = useT();
  const { navigate, openWorkspace } = useNavigation();
  const workspace = useWorkspace();
  const [preview, setPreview] = useState<Preview>();
  const [state, setState] = useState<"idle" | "picking" | "importing" | "uncertain">("idle");
  const [error, setError] = useState<TranslationKey>();
  const [expired, setExpired] = useState(false);
  // T17: an import whose Bots are committed but some skills were not written stays open to say so.
  const [partial, setPartial] = useState<{
    skills: string[];
    sources: { botId: string; skill: TeamSkillReimport }[];
    finish(): void;
  }>();
  const life = useRef<{ active: boolean; previewId?: string; locked: boolean }>({
    active: true,
    locked: false,
  });
  useEffect(() => {
    const current = { active: true, locked: false, previewId: undefined as string | undefined };
    life.current = current;
    setPreview(undefined);
    setState("idle");
    setError(undefined);
    return () => {
      current.active = false;
      if (peer && (current.previewId || current.locked))
        void peer
          .call("teams.cancel", current.previewId ? { previewId: current.previewId } : {})
          .catch(() => {
            /* Peer disposal also stops brain and clears its preview cache. */
          });
    };
  }, [peer]);
  useEffect(() => {
    setExpired(false);
    if (!preview) return;
    const delay = Math.max(0, Date.parse(preview.expiresAt) - Date.now());
    const timer = window.setTimeout(() => setExpired(true), delay);
    return () => window.clearTimeout(timer);
  }, [preview]);
  const choose = async () => {
    const current = life.current;
    if (!peer || current.locked) return;
    current.locked = true;
    setState("picking");
    setError(undefined);
    try {
      if (current.previewId) await peer.call("teams.cancel", { previewId: current.previewId });
      current.previewId = undefined;
      if (!current.active) return;
      setPreview(undefined);
      const result = await peer.call("teams.pickFile", undefined, { timeoutMs: 720_000 });
      if (!current.active) {
        if (result) await peer.call("teams.cancel", { previewId: result.previewId });
        return;
      }
      current.previewId = result?.previewId;
      setPreview(result ?? undefined);
    } catch (error) {
      if (current.active && error instanceof RpcError && error.message === "team_preview_expired")
        setExpired(true);
      if (current.active)
        setError(
          error instanceof RpcError && error.code === RpcErrorCodes.busy
            ? "teams.busy"
            : error instanceof RpcError && error.message === "team_too_large"
              ? "teams.tooLarge"
              : error instanceof RpcError && error.message === "team_unsafe"
                ? "teams.unsafe"
                : "teams.readFailed",
        );
    } finally {
      current.locked = false;
      if (current.active) setState("idle");
    }
  };
  const confirm = async () => {
    const current = life.current;
    if (!peer || !preview || current.locked || expired || state === "uncertain") return;
    current.locked = true;
    setState("importing");
    setError(undefined);
    let uncertain = false;
    try {
      const result = await peer.call("teams.import", { previewId: preview.previewId });
      current.previewId = undefined;
      if (!current.active) return;
      const groupId = result.groupIds[0],
        botId = result.botIds[0];
      const finish = () => {
        close();
        if (groupId) navigate({ name: "chat", groupId });
        else if (botId) navigate({ name: "chat", botId });
      };
      void workspace.refresh();
      const sources = preview.template.bots.flatMap((bot, index) =>
        (bot.skills ?? []).flatMap((skill) =>
          "reimport" in skill ? [{ botId: result.botIds[index] as string, skill }] : [],
        ),
      );
      if (!result.skippedSkills?.length && !sources.length) return finish();
      // Bot IDs come back in template order, so the preview names them.
      const names = new Map(
        result.botIds.map((id, index) => [id, preview.template.bots[index]?.name ?? ""]),
      );
      setPartial({
        sources,
        skills: (result.skippedSkills ?? []).map((skill) =>
          t("teams.skippedSkill", { skill: skill.name, bot: names.get(skill.botId) ?? "" }),
        ),
        finish,
      });
    } catch (error) {
      uncertain =
        !(error instanceof RpcError) ||
        error.code === RpcErrorCodes.timeout ||
        error.code === RpcErrorCodes.closed;
      if (current.active && error instanceof RpcError && error.message === "team_preview_expired")
        setExpired(true);
      if (current.active)
        setError(
          uncertain
            ? "teams.uncertain"
            : error instanceof RpcError && error.message === "team_preview_expired"
              ? "teams.expired"
              : "teams.importFailed",
        );
    } finally {
      current.locked = false;
      if (current.active) setState(uncertain ? "uncertain" : "idle");
    }
  };
  if (partial)
    return (
      <Overlay
        icon="users"
        tone="teal"
        title={t("builtin.custom.importTitle")}
        close={partial.finish}
      >
        <div role="status">
          <p>{t("teams.importedPartly")}</p>
          <ul>
            {partial.skills.map((skill, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: A fixed list; two skills may share a name.
              <li key={index}>{skill}</li>
            ))}
          </ul>
          <p className={styles.note}>{t("teams.skippedHint")}</p>
          {partial.sources.map(({ botId, skill }) => (
            <TeamSourceSkill key={`${botId}:${skill.folder}`} botId={botId} skill={skill} />
          ))}
        </div>
        <div className={styles.actions}>
          <Button className={styles.primary} onClick={partial.finish}>
            {t("teams.done")}
          </Button>
        </div>
      </Overlay>
    );
  return (
    <Overlay
      icon="users"
      tone="teal"
      title={t("builtin.custom.importTitle")}
      close={close}
      busy={state === "importing"}
    >
      {!preview && <p className={styles.note}>{t("teams.empty")}</p>}
      {state === "picking" && <p role="status">{t("teams.picking")}</p>}
      {preview && (
        <>
          {preview.provenance && (
            <p role="status" className={styles.note}>
              {t(
                preview.provenance.status === "official"
                  ? "teams.provenanceOfficial"
                  : "teams.provenanceUnverified",
              )}
            </p>
          )}
          <TeamPreview preview={preview} />
        </>
      )}
      {expired && (
        <p role="status" className={styles.note}>
          {t("teams.expired")}
        </p>
      )}
      {error && (
        <p role={state === "uncertain" ? "status" : "alert"} className={styles.error}>
          {t(error)}
        </p>
      )}
      <div className={styles.actions}>
        <Button variant="pill" disabled={!peer || state !== "idle"} onClick={() => void choose()}>
          {t(preview ? "teams.chooseAgain" : "teams.choose")}
        </Button>
        {preview && (
          <Button
            className={styles.primary}
            disabled={expired || state !== "idle" || !peer}
            loading={state === "importing"}
            onClick={() => void confirm()}
          >
            {t("teams.confirm")}
          </Button>
        )}
        {state === "uncertain" && (
          <Button
            variant="pill"
            onClick={() => {
              close();
              void workspace.refresh();
            }}
          >
            {t("workspace.refresh")}
          </Button>
        )}
      </div>
      {/* Maintainers 2026-11-13: the other whole-team path, moved here with the ＋ menu's import row. */}
      {!preview && (
        <button
          type="button"
          className={styles.professions}
          disabled={state !== "idle"}
          onClick={() => openWorkspace({ name: "professions" })}
        >
          <IconTile icon="briefcase" tone="violet" size="lg" />
          <span className={styles.professionsText}>
            <span className={styles.professionsTitle}>{t("builtin.settings.entry")}</span>
            <span className={styles.note}>{t("teams.professionsNote")}</span>
          </span>
          <Icon name="chevronRight" size={16} />
        </button>
      )}
    </Overlay>
  );
}
