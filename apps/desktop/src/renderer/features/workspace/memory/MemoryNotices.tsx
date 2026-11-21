import { type Peer, useT } from "@pibot/renderer-kit";
import { Button, IconTile } from "@pibot/ui";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import styles from "../workspace.module.css";
import { AutoMemoryNotice } from "./AutoMemoryNotice.tsx";
import { MemoryProposalReview } from "./MemoryProposalReview.tsx";
import { memoryNoticeStorage } from "./memory-notice-storage.ts";
import {
  type MemoryNoticeState,
  MemoryNoticesController,
  memoryNoticesByMessage,
} from "./memory-notices.ts";

export type MemoryNoticesModel = ReturnType<typeof useMemoryNotices>;

const idle: MemoryNoticeState = { loading: false, busy: false };
const noSubscription = () => () => {};
const idleSnapshot = () => idle;

/**
 * One controller per peer / Bot / topic. The chat reads it twice: the cards under the reply
 * that produced each notice, and the load error above the composer.
 */
export function useMemoryNotices(
  peer: Pick<Peer, "call" | "on"> | undefined,
  botId: string | undefined,
  conversationId: string | undefined,
) {
  // Conversation identity clears feedback too; loaded-message filtering alone cannot do that.
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new topic owns a new controller lifetime.
  const controller = useMemo(
    () =>
      peer && botId
        ? new MemoryNoticesController(peer, botId, memoryNoticeStorage(botId))
        : undefined,
    [peer, botId, conversationId],
  );
  const state = useSyncExternalStore(
    controller?.subscribe ?? noSubscription,
    controller?.getSnapshot ?? idleSnapshot,
    controller?.getSnapshot ?? idleSnapshot,
  );
  useEffect(() => {
    if (!controller) return;
    void controller.start();
    return () => controller.dispose();
  }, [controller]);
  const byMessage = useMemo(() => memoryNoticesByMessage(state), [state]);
  return { controller, state, byMessage };
}

/** The notices one reply produced, directly under it (gaps-bits b-memnotes). */
export function MessageMemoryNotices({
  notices,
  messageId,
}: {
  notices: MemoryNoticesModel;
  messageId: string;
}) {
  const t = useT();
  const { controller, state } = notices;
  const scoped = notices.byMessage.get(messageId);
  if (!controller || !scoped) return null;
  const { pending, undoable, feedback } = scoped;
  if (!pending.length && !undoable.length && !feedback) return null;
  const busy = state.busy || state.loading;
  return (
    <aside aria-label={t("workspace.memory")} className={styles.memoryNotices}>
      {undoable.map((proposal) => (
        <AutoMemoryNotice
          key={proposal.id}
          proposal={proposal}
          controller={controller}
          busy={busy}
        />
      ))}
      {pending.map((proposal) => (
        <div key={proposal.id} className={`${styles.item} ${styles.memoryProposal}`}>
          <MemoryProposalReview
            proposal={proposal}
            memories={state.profile?.memories}
            loading={state.loading}
            busy={busy}
            resolve={(accept) => void controller.resolve(proposal.id, accept)}
            mark={<IconTile icon="star" tone="violet" size="sm" className={styles.noticeMark} />}
          />
        </div>
      ))}
      {feedback && (
        <p
          role={feedback.key === "workspace.undoDone" ? "status" : "alert"}
          className={styles.noticeFeedback}
        >
          {t(feedback.key)}
        </p>
      )}
    </aside>
  );
}

/** A failed read belongs to no reply; it stays above the composer with its retry. */
export function MemoryNoticesStatus({ notices }: { notices: MemoryNoticesModel }) {
  const t = useT();
  const { controller, state } = notices;
  if (!controller || !state.error) return null;
  return (
    <p role="alert" className={styles.error}>
      {t(state.error)}{" "}
      <Button
        variant="ghost"
        disabled={state.busy || state.loading}
        onClick={() => void controller.refresh()}
      >
        {t("common.retry")}
      </Button>
    </p>
  );
}
