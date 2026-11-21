import type { ForegroundCommandState } from "@pibot/protocol";
import { approvalStyles as styles, useRpc, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";

export function ForegroundButton({
  botId,
  runId,
  toolCallId,
}: {
  botId: string;
  runId: string;
  toolCallId: string;
}) {
  const { peer } = useRpc();
  const t = useT();
  const [state, setState] = useState<ForegroundCommandState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const acting = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    generation.current++;
    setState(null);
    setBusy(false);
    setError(false);
    if (!peer) return;
    let live = true;
    let received = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const off = peer.on("foregroundCommands.changed", (value) => {
      if (value.botId === botId && value.runId === runId && value.toolCallId === toolCallId) {
        received = true;
        setState(value);
      }
    });
    void peer
      .call("foregroundCommands.get", { botId, runId, toolCallId }, { signal: controller.signal })
      .then(
        (value) => {
          if (live && !received) setState(value);
        },
        () => {
          /* Older targets have no promotion capability; their button stays hidden. */
        },
      )
      .finally(() => clearTimeout(timer));
    return () => {
      live = false;
      generation.current++;
      acting.current?.abort();
      controller.abort();
      clearTimeout(timer);
      off();
    };
  }, [peer, botId, runId, toolCallId]);
  // A retired row must never display another call's state while its effect catches up.
  if (
    !state?.active ||
    state.runId !== runId ||
    state.toolCallId !== toolCallId ||
    state.botId !== botId
  )
    return null;
  return (
    <div className={styles.actions}>
      <Button
        variant="ghost"
        disabled={!state.available || busy || !peer}
        onClick={async () => {
          if (!peer || busy) return;
          const current = generation.current;
          const controller = new AbortController();
          acting.current = controller;
          setBusy(true);
          setError(false);
          try {
            await peer.call(
              "foregroundCommands.promote",
              { botId, runId, toolCallId },
              { timeoutMs: 15_000, signal: controller.signal },
            );
          } catch {
            if (current === generation.current) setError(true);
          } finally {
            if (acting.current === controller) acting.current = undefined;
            if (current === generation.current) setBusy(false);
          }
        }}
      >
        {t("background.promote")}
      </Button>
      {state.reason === "limit" && <span>{t("background.limit")}</span>}
      {error && <span role="alert">{t("background.actionError")}</span>}
    </div>
  );
}
