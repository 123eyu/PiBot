import type { DeliveryEvidence } from "@pibot/protocol";
import { useRpc, useSettings, useT } from "@pibot/renderer-kit";
import { Button, CloseButton, Icon } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import { RunLogButton } from "../run-log/Viewer.tsx";
import { ReviewFindings } from "./ReviewFindings.tsx";
import styles from "./review-evidence.module.css";
import { useEvidenceRecord } from "./review-evidence-data.ts";

export function DeliveryEvidenceRecord({
  entry,
  revision,
}: {
  entry: DeliveryEvidence;
  revision: number;
}) {
  const { t, language } = useSettings(),
    [open, setOpen] = useState(false);
  return (
    <article className={styles.row}>
      <Button
        variant="ghost"
        className={styles.recordSummary}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={open ? "chevron" : "chevronRight"} size={13} />
        <span>
          {entry.kind === "command"
            ? t("agentReview.command", { code: entry.exitCode ?? t("agentReview.unknown") })
            : t(`agentReview.record.${entry.kind}`)}
        </span>
        <time className={styles.time} dateTime={entry.createdAt}>
          {new Date(entry.createdAt).toLocaleString(language)}
        </time>
      </Button>
      {open && <DeliveryRecordDetails entry={entry} revision={revision} />}
    </article>
  );
}
function DeliveryRecordDetails({ entry, revision }: { entry: DeliveryEvidence; revision: number }) {
  const { peer } = useRpc(),
    t = useT(),
    [retry, setRetry] = useState(0);
  const record = useEvidenceRecord(
    peer,
    `${entry.botId}:${entry.conversationId}:${entry.id}`,
    revision + retry,
    async (signal) => {
      if (!peer) throw new Error("Disconnected");
      const value = await peer.call(
        "deliveryEvidence.get",
        { botId: entry.botId, conversationId: entry.conversationId, id: entry.id },
        { signal, timeoutMs: 20000 },
      );
      if (
        value.id !== entry.id ||
        value.botId !== entry.botId ||
        value.conversationId !== entry.conversationId ||
        value.kind !== entry.kind
      )
        throw new Error("Evidence scope mismatch");
      return value;
    },
  );
  const [image, setImage] = useState<string>(),
    [imageError, setImageError] = useState(false),
    [imageBusy, setImageBusy] = useState(false);
  const active = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => active.current?.abort(), []);
  const screenshot = async (value: Extract<DeliveryEvidence, { kind: "screenshot" }>) => {
    if (!peer || imageBusy) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setImage(undefined);
    setImageError(false);
    setImageBusy(true);
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]);
      const checked = await peer.call(
        "deliveryEvidence.get",
        { botId: value.botId, conversationId: value.conversationId, id: value.id },
        { signal, timeoutMs: 20000 },
      );
      if (
        checked.kind !== "screenshot" ||
        !checked.available ||
        checked.computerStepId !== value.computerStepId
      )
        throw new Error("Unavailable screenshot");
      const result = await peer.call(
        "computer.screenshot.view",
        { stepId: checked.computerStepId },
        { signal, timeoutMs: 20000 },
      );
      if (!signal.aborted) setImage(`data:${result.mimeType};base64,${result.data}`);
    } catch {
      if (!controller.signal.aborted) setImageError(true);
    } finally {
      if (!controller.signal.aborted) setImageBusy(false);
    }
  };
  const value = record.value;
  return (
    <div className={styles.recordDetails}>
      {record.busy && <p role="status">{t("common.loading")}</p>}
      {record.error && (
        <p role="alert" className={styles.error}>
          {t("agentReview.unavailable")}{" "}
          <Button variant="ghost" onClick={() => setRetry((v) => v + 1)}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {value?.kind === "command" && (
        <>
          <p>
            {t(
              value.exitCode === 0 && value.toolStatus === "done"
                ? "agentReview.status.commandDone"
                : "agentReview.status.commandOther",
            )}{" "}
            · {t("agentWork.exitCode", { code: value.exitCode ?? t("agentReview.unknown") })}
          </p>
          {value.logAvailable ? (
            <RunLogButton
              details={{
                runId: value.runId,
                ...(value.toolCallId ? { toolCallId: value.toolCallId } : {}),
                botId: value.botId,
                command: t("agentReview.command", {
                  code: value.exitCode ?? t("agentReview.unknown"),
                }),
                exitCode: value.exitCode,
                durationMs: value.durationMs,
              }}
            />
          ) : (
            <p className={styles.hint}>{t("agentReview.unavailable")}</p>
          )}
        </>
      )}
      {value?.kind === "screenshot" && (
        <Button
          variant="ghost"
          disabled={imageBusy || !value.available}
          onClick={() => void screenshot(value)}
        >
          {t("agentReview.screenshot")}
        </Button>
      )}
      {value?.kind === "unverified" && <p>{t("agentReview.unverified", { label: value.label })}</p>}
      {value?.kind === "review" && <ReviewFindings review={value.review} />}

      {imageError && (
        <p role="alert" className={styles.error}>
          {t("agentReview.unavailable")}
        </p>
      )}
      {image && (
        <div className={styles.image}>
          <CloseButton label={t("attachments.close")} onClick={() => setImage(undefined)} />
          <img src={image} alt={t("agentReview.screenshotAlt")} />
        </div>
      )}
    </div>
  );
}
