import { type Bot, type Message, RpcError, RpcErrorCodes } from "@pibot/protocol";
import { useRpc, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { requirePeer, updateBot } from "../../settings/operations.ts";
import { Overlay } from "../../workspace/Overlay.tsx";
import { useCatalog } from "../../workspace/profile/catalog.ts";
import { ModelFields, normalizedThinking } from "../../workspace/profile/ModelFields.tsx";
import styles from "../chat.module.css";
import { RecoveryStatus } from "./RecoveryStatus.tsx";

export function ModelRecovery({ message, bot }: { message: Message; bot?: Bot }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (
    !bot ||
    bot.category === "image" ||
    // An external agent's model is its own; its errors carry their own guidance.
    bot.kind === "agent" ||
    !message.runId ||
    (message.status !== "error" &&
      message.status !== "aborted" &&
      message.errorCode !== "output_limit")
  )
    return null;
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {t(
          message.errorCode === "output_limit"
            ? "chat.adjustModel"
            : [
                  "auth_failed",
                  "quota_exhausted",
                  "billing",
                  "provider_rejected",
                  "chatgpt_plan_not_eligible",
                ].includes(message.errorCode ?? "")
              ? "chat.changeModel"
              : "recovery.title",
        )}
      </Button>
      {open &&
        createPortal(
          <ModelRecoveryDialog message={message} bot={bot} close={() => setOpen(false)} />,
          document.body,
        )}
    </>
  );
}

function ModelRecoveryDialog({
  message,
  bot,
  close,
}: {
  message: Message;
  bot: Bot;
  close(): void;
}) {
  const t = useT(),
    { peer } = useRpc(),
    catalog = useCatalog();
  const [value, setValue] = useState(JSON.stringify([bot.modelProvider, bot.modelId]));
  const [thinking, setThinking] = useState<Bot["thinkingLevel"] | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const locked = useRef(false),
    lifetime = useRef(new AbortController());
  useEffect(() => {
    lifetime.current = new AbortController();
    return () => lifetime.current.abort();
  }, []);
  const selected = catalog.models.find((m) => JSON.stringify([m.provider, m.id]) === value);
  const submit = async () => {
    if (!selected || !message.runId || locked.current || !ready) return;
    locked.current = true;
    setBusy(true);
    setError(false);
    const signal = AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(30_000)]);
    const thinkingLevel = normalizedThinking(
      selected,
      thinking ??
        (bot.thinkingPreference === undefined ? bot.thinkingLevel : bot.thinkingPreference),
    );
    try {
      await saveBotModel(requirePeer(peer), bot, selected, thinkingLevel);
      await requirePeer(peer).call(
        "runs.retry",
        {
          source: "dm",
          botId: bot.id,
          conversationId: message.conversationId,
          failedRunId: message.runId,
          model: { provider: selected.provider, id: selected.id },
          thinkingLevel,
        },
        { signal, timeoutMs: 30_000 },
      );
      if (!lifetime.current.signal.aborted) close();
    } catch (cause) {
      if (!lifetime.current.signal.aborted) {
        setUncertain(
          signal.aborted || (cause instanceof RpcError && cause.code === RpcErrorCodes.timeout),
        );
        setError(true);
      }
    } finally {
      locked.current = false;
      if (!lifetime.current.signal.aborted) setBusy(false);
    }
  };
  return (
    <Overlay icon="key" tone="violet" title={t("chat.recoverModel")} close={close} busy={busy}>
      <p>{bot.name}</p>
      <p className={styles.notice}>{t("chat.recoverModelHelp")}</p>
      <RecoveryStatus message={message} bot={bot} checked={setReady} close={close} busy={busy} />
      <ModelFields
        models={catalog.models}
        providers={catalog.providers}
        value={value}
        thinking={normalizedThinking(
          selected ?? { reasoning: false },
          thinking ??
            (bot.thinkingPreference === undefined ? bot.thinkingLevel : bot.thinkingPreference),
        )}
        disabled={busy || catalog.loading || uncertain}
        change={(next, level) => {
          setValue(next);
          if (level !== undefined) setThinking(level);
        }}
      />
      {catalog.loading && <p role="status">{t("common.loading")}</p>}
      {catalog.error && (
        <p role="alert">
          {t("group.recoverModelsError")}{" "}
          <Button variant="ghost" onClick={catalog.reload}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {error && (
        <p role="alert">{t(uncertain ? "group.recoverUncertain" : "group.recoverFailed")}</p>
      )}
      <div className={styles.actions}>
        <Button variant="secondary" disabled={busy} onClick={close}>
          {t("common.cancel")}
        </Button>
        <Button
          loading={busy}
          disabled={busy || !ready || !selected || catalog.loading || catalog.error || !peer}
          onClick={() => void submit()}
        >
          {t(uncertain ? "group.recoverCheck" : "chat.recoverModel")}
        </Button>
      </div>
    </Overlay>
  );
}

/**
 * The model picked to recover is the Bot's model from now on, not only for this attempt (owner
 * 2026-11-01: the next message failed again on the old model). Saved like the profile does.
 */
export async function saveBotModel(
  peer: Parameters<typeof updateBot>[0],
  bot: Bot,
  model: { provider: string; id: string },
  thinkingLevel: Bot["thinkingLevel"],
) {
  const modelChanged = model.provider !== bot.modelProvider || model.id !== bot.modelId;
  if (!modelChanged && thinkingLevel === bot.thinkingLevel) return;
  await updateBot(peer, {
    botId: bot.id,
    ...(modelChanged ? { modelProvider: model.provider, modelId: model.id } : {}),
    ...(thinkingLevel !== bot.thinkingLevel ? { thinkingLevel } : {}),
  });
}
