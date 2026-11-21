import { GroupPlanDoneSchema, type Message } from "@pibot/protocol";
import { useRpc, useT } from "@pibot/renderer-kit";
import { WorkflowEditorDialog } from "@pibot/skills/ui";
import type { WorkflowDocument } from "@pibot/skills-contract/full";
import { Button } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import type { GroupSnapshot } from "../data.ts";
import styles from "./group-plan.module.css";

/**
 * 「保存为常用计划」 under the program's completion message of a dynamic plan whose every
 * step passed. The brain drafts the document from the plan as it ran (no model call); the user
 * reviews it in the workflow editor, which saves through `skills.createWorkflow` as usual.
 */
export function GroupPlanSave({
  message,
  group,
}: {
  message: Message;
  group: NonNullable<GroupSnapshot["group"]>;
}) {
  const t = useT();
  const { peer } = useRpc();
  const request = useRef<AbortController | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState(false);
  const [statusRevision, retryStatus] = useState(0);
  const [document, setDocument] = useState<WorkflowDocument>();
  const usage = message.usage;
  const done = GroupPlanDoneSchema.safeParse(
    usage && typeof usage === "object" && !Array.isArray(usage) ? usage.groupPlanDone : undefined,
  );
  const workflowRunId = done.success ? done.data.workflowRunId : undefined;
  const [saveState, setSaveState] = useState<"available" | "saved" | "rerun" | "unavailable">();
  // biome-ignore lint/correctness/useExhaustiveDependencies: statusRevision explicitly retries a failed status read.
  useEffect(() => {
    setSaveState(undefined);
    if (!peer || !workflowRunId) return;
    const abort = new AbortController();
    let revision = 0;
    const read = () => {
      const current = ++revision;
      void peer
        .call(
          "skills.planSaveState",
          { groupId: group.id, workflowRunId },
          { signal: abort.signal, timeoutMs: 10_000 },
        )
        .then((result) => {
          if (!abort.signal.aborted && current === revision) {
            setSaveState(result.state);
            setFailed(false);
          }
        })
        .catch(() => {
          if (!abort.signal.aborted && current === revision) setFailed(true);
        });
    };
    const off = peer.on("skills.changed", (event) => {
      if (event.groupId === group.id) read();
    });
    read();
    return () => {
      abort.abort();
      off();
    };
  }, [peer, group.id, workflowRunId, statusRevision]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A different message owns its own draft request.
  useEffect(() => {
    setBusy(false);
    setFailed(false);
    setSaved(false);
    setDocument(undefined);
    return () => {
      request.current?.abort();
      request.current = undefined;
    };
  }, [peer, group.id, message.id]);
  if (
    !done.success ||
    saveState === "rerun" ||
    saveState === "unavailable" ||
    (!saveState && !failed)
  )
    return null;
  const draft = async () => {
    // The ref is set synchronously, so a second click before React commits `busy` is ignored.
    if (!peer || request.current) return;
    const abort = new AbortController();
    request.current = abort;
    setBusy(true);
    setFailed(false);
    try {
      const result = await peer.call(
        "groups.plan.template",
        { groupId: group.id, workflowRunId: done.data.workflowRunId },
        { signal: abort.signal, timeoutMs: 30_000 },
      );
      if (!abort.signal.aborted) setDocument(result.document);
    } catch {
      if (!abort.signal.aborted) setFailed(true);
    } finally {
      if (request.current === abort) {
        request.current = undefined;
        setBusy(false);
      }
    }
  };
  return (
    <>
      {saved || saveState === "saved" ? (
        <p role="status" className={styles.note}>
          {t("group.plan.templateSaved")}
        </p>
      ) : (
        <Button
          variant="ghost"
          loading={busy}
          disabled={!peer || !saveState}
          onClick={() => void draft()}
        >
          {t("group.plan.saveTemplate")}
        </Button>
      )}
      {failed && (
        <p role="alert" className={styles.note}>
          {t("group.plan.templateFailed")}
          {!saveState && (
            <Button variant="ghost" onClick={() => retryStatus((value) => value + 1)}>
              {t("common.retry")}
            </Button>
          )}
        </p>
      )}
      {document && (
        <WorkflowEditorDialog
          botId={group.coordinatorBotId}
          groupId={group.id}
          initial={document}
          fromPlan={done.data}
          close={() => setDocument(undefined)}
          saved={() => {
            setDocument(undefined);
            setSaved(true);
          }}
        />
      )}
    </>
  );
}
