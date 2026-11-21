import { useRpc, useT } from "@pibot/renderer-kit";
import {
  RpcError,
  RpcErrorCodes,
  type Skill,
  type SkillContract,
  type WorkflowDocument,
  WorkflowDocumentSchema,
} from "@pibot/skills-contract/full";
import { Button, IconTile } from "@pibot/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { WorkflowDeliveryEditor } from "./WorkflowDeliveryEditor.tsx";
import { EditorField, EditorSection } from "./WorkflowEditorParts.tsx";
import { WorkflowInputEditor } from "./WorkflowInputEditor.tsx";
import { WorkflowRulesEditor } from "./WorkflowRulesEditor.tsx";
import { WorkflowStepEditor } from "./WorkflowStepEditor.tsx";
import styles from "./workflow.module.css";
import { contractFromDocument, matchesSavedDocument } from "./workflow-document.ts";

const emptyContract: SkillContract = {
  inputs: [],
  prechecks: [],
  deliverables: [],
  acceptance: [],
  stop: [],
  maxFixRounds: 2,
  approvals: [],
};

const emptyDocument: WorkflowDocument = {
  name: "",
  description: "",
  body: "",
  params: [],
  contract: emptyContract,
};

export function WorkflowEditorDialog({
  botId,
  groupId,
  skillId,
  initial,
  fromPlan,
  close,
  saved,
}: {
  botId: string;
  groupId?: string;
  skillId?: string;
  initial?: WorkflowDocument;
  /** The passed plan this draft came from; the brain verifies it before recording. */
  fromPlan?: { workflowRunId: string };
  close(): void;
  saved(): void;
}) {
  const t = useT();
  const { peer } = useRpc();
  const [document, setDocument] = useState<WorkflowDocument>(initial ?? emptyDocument);
  const [loading, setLoading] = useState(!!skillId);
  const [ready, setReady] = useState(!skillId);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [saveUnknown, setSaveUnknown] = useState(false);
  const [serverPath, setServerPath] = useState<string>();
  const [revision, setRevision] = useState(0);
  const saving = useRef(false);
  const request = useRef<AbortController | undefined>(undefined);
  const saveAttempt = useRef<{ key: string; requestId: string } | undefined>(undefined);
  const parsed = useMemo(
    () =>
      WorkflowDocumentSchema.safeParse({
        ...document,
        contract: {
          ...document.contract,
          state: document.contract.inputs.some((input) => input.kind === "previous")
            ? { readPrevious: true }
            : undefined,
        },
      }),
    [document],
  );
  const invalidPaths = new Set(
    parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.map(String).join(".")),
  );
  if (serverPath) invalidPaths.add(serverPath);
  const invalid = (path: string) =>
    [...invalidPaths].some((item) => item === path || item.startsWith(`${path}.`));
  const setContract = (contract: SkillContract) =>
    setDocument((current) => ({ ...current, contract }));

  // biome-ignore lint/correctness/useExhaustiveDependencies: Revision explicitly retries the read.
  useEffect(() => {
    if (!peer || !skillId) return;
    const abort = new AbortController();
    setLoading(true);
    setReady(false);
    setLoadError(false);
    void peer
      .call("skills.get", { groupId, skillId }, { signal: abort.signal })
      .then(({ skill, document: stored }) => {
        if (abort.signal.aborted) return;
        if (skill.botId !== botId) throw new Error("workflow_owner_changed");
        const contract = contractFromDocument(stored);
        if (!contract) throw new Error("workflow_contract_invalid");
        const next = WorkflowDocumentSchema.safeParse({
          name: stored.name,
          description: stored.description,
          body: stored.body,
          params: stored.params,
          contract,
        });
        if (!next.success) throw new Error("workflow_contract_invalid");
        setDocument(next.data);
        setReady(true);
      })
      .catch(() => {
        if (!abort.signal.aborted) setLoadError(true);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [peer, botId, groupId, skillId, revision]);
  useEffect(
    () => () => {
      request.current?.abort();
    },
    [],
  );

  const submit = async () => {
    if (!peer || !ready || !parsed.success || saving.current) return;
    saving.current = true;
    const key = JSON.stringify(parsed.data);
    const attempt =
      saveAttempt.current?.key === key
        ? saveAttempt.current
        : { key, requestId: crypto.randomUUID() };
    saveAttempt.current = attempt;
    const abort = new AbortController();
    request.current = abort;
    setBusy(true);
    setSaveError(false);
    setSaveUnknown(false);
    setServerPath(undefined);
    const persist = (timeoutMs: number): Promise<Skill> =>
      skillId
        ? peer.call(
            "skills.update",
            { groupId, skillId, requestId: attempt.requestId, patch: parsed.data },
            { signal: abort.signal, timeoutMs },
          )
        : peer.call(
            "skills.createWorkflow",
            {
              botId,
              groupId,
              requestId: attempt.requestId,
              document: parsed.data,
              ...(fromPlan ? { fromPlan } : {}),
            },
            { signal: abort.signal, timeoutMs },
          );
    try {
      let savedSkill: Skill;
      try {
        savedSkill = await persist(30_000);
      } catch (error) {
        if (!(error instanceof RpcError) || error.code !== RpcErrorCodes.timeout) throw error;
        // The first call may have committed just as its response timed out. Reusing the request id
        // obtains that exact result (or safely starts it if cancellation won while still queued).
        savedSkill = await persist(60_000);
      }
      const confirmed = await peer.call(
        "skills.get",
        { groupId, skillId: savedSkill.id },
        { signal: abort.signal, timeoutMs: 30_000 },
      );
      if (confirmed.skill.botId !== botId || !matchesSavedDocument(confirmed.document, parsed.data))
        throw new Error("workflow_save_unconfirmed");
      saveAttempt.current = undefined;
      saved();
    } catch (error) {
      if (error instanceof RpcError && error.code === -32602) {
        saveAttempt.current = undefined;
        const path = error.message.replace(/^(document|patch)\./, "");
        if (path.startsWith("contract")) setServerPath(path);
        else setSaveError(true);
      } else if (
        error instanceof RpcError &&
        error.code !== RpcErrorCodes.timeout &&
        error.code !== RpcErrorCodes.closed
      ) {
        saveAttempt.current = undefined;
        setSaveError(true);
      } else if (!abort.signal.aborted) {
        // Keep the same request id for the next confirmation attempt: an unknown response must
        // never turn into a second create or a second version increment.
        setSaveUnknown(true);
      }
    } finally {
      if (request.current === abort) {
        request.current = undefined;
        saving.current = false;
        setBusy(false);
      }
    }
  };

  return (
    <div className={styles.overlay} role="presentation">
      <form
        className={`${styles.dialog} ${styles.editorDialog}`}
        aria-label={t(skillId ? "workflows.editor.edit" : "workflows.editor.create")}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2 className={styles.title}>
          <IconTile icon="edit" tone="violet" size="lg" />
          {t(skillId ? "workflows.editor.edit" : "workflows.editor.create")}
        </h2>
        {skillId && loadError ? (
          <div className={styles.loadFailure}>
            <p role="alert" className={styles.error}>
              {t("workflows.editor.loadError")}
            </p>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setRevision((value) => value + 1)}
            >
              {t("common.retry")}
            </Button>
          </div>
        ) : loading ? (
          <p role="status" className={styles.note}>
            {t("common.loading")}
          </p>
        ) : (
          <fieldset className={styles.editorFields} disabled={busy}>
            <EditorSection title={t("workflows.editor.basic")}>
              <EditorField label={t("workflows.editor.name")} invalid={invalid("name")}>
                <input
                  value={document.name}
                  maxLength={80}
                  disabled={busy}
                  onChange={(event) =>
                    setDocument({ ...document, name: event.currentTarget.value })
                  }
                />
              </EditorField>
              <EditorField label={t("workflows.editor.goal")} invalid={invalid("description")}>
                <input
                  value={document.description}
                  maxLength={1024}
                  disabled={busy}
                  onChange={(event) =>
                    setDocument({
                      ...document,
                      description: event.currentTarget.value.replace(/[\r\n]+/g, " "),
                    })
                  }
                />
              </EditorField>
              <EditorField label={t("workflows.editor.method")} invalid={invalid("body")}>
                <textarea
                  rows={6}
                  value={document.body}
                  disabled={busy}
                  onChange={(event) =>
                    setDocument({ ...document, body: event.currentTarget.value })
                  }
                />
              </EditorField>
            </EditorSection>
            <WorkflowInputEditor
              contract={document.contract}
              change={setContract}
              invalid={invalid}
            />
            <WorkflowDeliveryEditor
              contract={document.contract}
              change={setContract}
              invalid={invalid}
            />
            {groupId && (
              <WorkflowStepEditor
                groupId={groupId}
                contract={document.contract}
                change={setContract}
                invalid={invalid}
              />
            )}
            <WorkflowRulesEditor
              contract={document.contract}
              change={setContract}
              invalid={invalid}
            />
          </fieldset>
        )}
        {!loadError &&
          (saveError || saveUnknown || (!parsed.success && !loading) || serverPath) && (
            <p role="alert" className={styles.error}>
              {saveUnknown
                ? t("workflows.editor.saveUnknown")
                : saveError
                  ? t("workflows.editor.saveError")
                  : t("workflows.editor.invalid")}
            </p>
          )}
        {busy && (
          <p role="status" className={styles.note}>
            {t("workflows.editor.savingWait")}
          </p>
        )}
        <div className={styles.actions}>
          <Button type="button" variant="ghost" disabled={busy} onClick={close}>
            {t("common.cancel")}
          </Button>
          {!loadError && (
            <Button
              type="submit"
              variant="primary"
              className={styles.run}
              loading={busy}
              disabled={!ready || loading || busy || !parsed.success}
            >
              {t("common.save")}
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
