import {
  type ChatAdditionMode,
  chatAddition,
  type ExecutionMode,
  type Message,
} from "@pibot/protocol";
import { useRpc, useT } from "@pibot/renderer-kit";
import { Button, IconTile } from "@pibot/ui";
import { createContext, useContext, useEffect, useState } from "react";
import { PopupMenu } from "../../execution/PopupMenu.tsx";
import styles from "../chat.module.css";

export function SendOptions({
  send,
  disabled,
  image = false,
  agent = false,
  busy = false,
  draftMode,
  botId,
  modeControl,
}: {
  send?(mode: ChatAdditionMode): void;
  disabled: boolean;
  image?: boolean;
  agent?: boolean;
  busy?: boolean;
  draftMode?: ExecutionMode;
  /** Kept for callers; the mode itself is now chosen in ModeSwitch above the composer. */
  onDraftMode?(mode: ExecutionMode): void;
  botId?: string;
  modeControl?: { mode?: ExecutionMode; ready: boolean; change(mode: ExecutionMode): void };
}) {
  const t = useT();
  return (
    <div className={styles.sendOptions}>
      <PopupMenu label={t("chat.sendOptions")} icon="chevron" placement="above">
        {(botId || send || draftMode || modeControl) && (
          <>
            <p>{t("agentWork.whileBusy")}</p>
            {(image || agent ? (["followUp"] as const) : (["steer", "followUp"] as const)).map(
              (mode) => (
                <Button
                  key={mode}
                  variant="ghost"
                  disabled={disabled || !busy || !send}
                  onClick={() => send?.(mode)}
                >
                  <IconTile
                    icon={mode === "steer" ? "bolt" : "clock"}
                    tone={mode === "steer" ? "orange" : "amber"}
                    size="sm"
                  />
                  {t(image ? "media.next" : `chat.addition.${mode}`)}
                </Button>
              ),
            )}
          </>
        )}
      </PopupMenu>
    </div>
  );
}
/** Where a still-queued addition can be switched: the DM's Bot, or the group conversation. */
export type AdditionTarget =
  | { kind: "dm"; botId: string; agent?: boolean }
  | { kind: "group"; groupId: string; conversationId: string; agent?: boolean };

/**
 * What the chat around an addition knows: the run's current step (what a waiting addition waits
 * for) and how to put an unsent one back into the composer. Absent where a view has neither.
 */
export const AdditionContext = createContext<{
  activity?: { runId: string; phase: string };
  restore?(message: Message): void;
}>({});

function useElapsed(since: string, live: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return Math.max(0, Math.round((now - Date.parse(since)) / 1000));
}

export function AdditionStatus({ message, target }: { message: Message; target?: AdditionTarget }) {
  const t = useT(),
    { peer } = useRpc(),
    { activity, restore } = useContext(AdditionContext),
    addition = chatAddition(message),
    [busy, setBusy] = useState(false),
    [late, setLate] = useState(false),
    [restored, setRestored] = useState(false),
    queued = addition?.state === "queued",
    seconds = useElapsed(message.createdAt, queued);
  if (!addition) return null;
  const next: ChatAdditionMode = addition.mode === "steer" ? "followUp" : "steer";
  const step = activity?.runId === message.runId ? activity?.phase : undefined;
  // Waiting in the run's queue: say what it waits for and how long, so it does not look lost.
  const waitFor =
    addition.mode !== "steer"
      ? undefined
      : step === "executing_tool"
        ? t("chat.addition.waitTool")
        : step === "waiting_model" || step === "preparing_tool"
          ? t("chat.addition.waitModel")
          : t("chat.addition.waitStep");
  const waited =
    seconds < 60
      ? t("chat.addition.waited", { seconds })
      : t("chat.addition.waitedMinutes", { minutes: Math.floor(seconds / 60) });
  const state = t(
    addition.mode === "steer" ? "chat.additionState.queued" : "chat.additionState.queuedFollowUp",
  );
  const label = queued
    ? waitFor
      ? t("chat.addition.waitingFor", { state, reason: waitFor, waited })
      : t("chat.addition.waitingOnly", { state, waited })
    : addition.state === "unsent"
      ? t("chat.additionState.unsent")
      : `${t(`chat.additionState.${addition.state}`)} · ${t(`chat.addition.${addition.mode}`)}`;
  const change = async () => {
    if (!target || !peer || busy) return;
    setBusy(true);
    try {
      if (target.kind === "dm")
        await peer.call("chat.appendMode", {
          botId: target.botId,
          topicId: message.conversationId,
          requestId: message.id,
          mode: next,
        });
      else
        await peer.call("groups.appendMode", {
          groupId: target.groupId,
          conversationId: target.conversationId,
          requestId: message.id,
          mode: next,
        });
    } catch {
      // The run took it meanwhile (or ended): say so; the message's own update follows.
      setLate(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <p className={styles.additionStatus} role="status">
      {label}
      {queued && target && !target.agent && !late && (
        <>
          {" · "}
          <button type="button" className={styles.additionSwitch} disabled={busy} onClick={change}>
            {t(
              next === "followUp"
                ? "chat.addition.switchToFollowUp"
                : "chat.addition.switchToSteer",
            )}
          </button>
        </>
      )}
      {queued && late && ` · ${t("chat.addition.switchLate")}`}
      {addition.state === "unsent" && restore && (
        <>
          {" · "}
          {restored ? (
            t("chat.addition.restored")
          ) : (
            <button
              type="button"
              className={styles.additionSwitch}
              onClick={() => {
                restore(message);
                setRestored(true);
              }}
            >
              {t("chat.addition.restore")}
            </button>
          )}
        </>
      )}
    </p>
  );
}
