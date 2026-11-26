import { useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import type { ReactNode } from "react";
import styles from "./conversation-import.module.css";
import type { Preview, Selection } from "./import-state.ts";
import type { ImportDraft } from "./use-import-draft.ts";

export function ImportPreview({
  draft,
  preview,
  disabled,
}: {
  draft: ImportDraft;
  preview: Preview;
  disabled: boolean;
}) {
  const t = useT();
  const details = preview.exportDetails;
  const projects = (details?.projects ?? 0) + (preview.projectNotes ?? 0);
  const from = preview.from?.slice(0, 10);
  const through = preview.through?.slice(0, 10);
  return (
    <>
      <p className={styles.intro}>
        <strong>{t(`conversationImport.source.${preview.source}`)}</strong>
        {from && through && ` · ${t("conversationImport.dateRange", { from, through })}`}
        {" · "}
        {t("conversationImport.previewNote")}
      </p>
      <fieldset
        className={styles.card}
        aria-label={t("conversationImport.preview")}
        disabled={disabled}
      >
        <div className={styles.controlRow}>
          <label className={styles.selectRow}>
            <span>{t("conversationImport.target")}</span>
            <select value={draft.botId} onChange={(event) => draft.changeBot(event.target.value)}>
              {!draft.botId && <option value="">{t("conversationImport.selectBot")}</option>}
              {draft.bots.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name}
                </option>
              ))}
            </select>
          </label>
          {draft.moreBots && (
            <Button variant="ghost" disabled={disabled} onClick={() => void draft.moreBots?.()}>
              {t("conversationImport.moreBots")}
            </Button>
          )}
        </div>
        {preview.topics > 0 && (
          <CheckRow
            checked={draft.conversations}
            change={draft.changeConversations}
            title={t("conversationImport.conversationCount", { count: preview.topics })}
            note={t("conversationImport.readOnlyNote", { count: preview.messages })}
          />
        )}
        {details && (details.memories > 0 || details.customInstructions > 0) && (
          <ReviewRows draft={draft} preview={preview} />
        )}
        {projects > 0 && (
          <div className={styles.section}>
            <div className={styles.controlRow}>
              <div>
                <strong>{t("conversationImport.projectCount", { count: projects })}</strong>
                <small>{t("conversationImport.projectNote")}</small>
              </div>
              <Button variant="secondary" disabled={!draft.botId} onClick={draft.reviewProject}>
                {t(
                  draft.project
                    ? "conversationImport.changeFolder"
                    : "conversationImport.chooseFolder",
                )}
              </Button>
            </div>
            {draft.project && (
              <>
                <p className={styles.path} dir="auto">
                  {draft.project.folder} · {draft.project.file}
                </p>
                <section
                  className={styles.diff}
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users must be able to scroll the diff.
                  tabIndex={0}
                  aria-label={t("conversationImport.projectDiff")}
                >
                  <pre>{draft.project.diff}</pre>
                </section>
                <CheckRow
                  checked={draft.projectConfirmed}
                  change={draft.setProjectConfirmed}
                  title={t("conversationImport.confirmProjectDiff")}
                  note={t("conversationImport.projectApproval")}
                />
              </>
            )}
          </div>
        )}
        {preview.topics > 0 && (
          <CheckRow
            checked={!!draft.quote || draft.busy === "quote"}
            disabled={!draft.conversations || !draft.botId}
            change={draft.toggleQuote}
            title={t("conversationImport.distil")}
            note={
              draft.quote
                ? t("conversationImport.quote", {
                    model: draft.quote.modelId,
                    count: draft.quote.maxTokens,
                    cost: draft.quote.costUsd,
                  })
                : t(
                    draft.quoteUnavailable
                      ? "conversationImport.quoteUnavailable"
                      : "conversationImport.distilNote",
                  )
            }
          />
        )}
        {!preview.topics && !projects && !details?.memories && !details?.customInstructions && (
          <p className={styles.intro}>{t("conversationImport.empty")}</p>
        )}
      </fieldset>
      <PreviewSkipped preview={preview} />
      <p className={styles.intro}>{t("conversationImport.dataNote")}</p>
    </>
  );
}

function CheckRow({
  title,
  note,
  checked,
  change,
  disabled,
}: {
  title: ReactNode;
  note?: string;
  checked: boolean;
  change(checked: boolean): void;
  disabled?: boolean;
}) {
  return (
    <label className={styles.check}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => change(event.target.checked)}
      />
      <span>
        <strong>{title}</strong>
        {note && <small>{note}</small>}
      </span>
    </label>
  );
}

function ReviewRows({ draft, preview }: { draft: ImportDraft; preview: Preview }) {
  const t = useT();
  const memoryCount = preview.exportDetails?.memories ?? 0;
  const instructions = preview.exportDetails?.customInstructions ?? 0;
  return (
    <>
      <div className={styles.section}>
        <div className={styles.controlRow}>
          <div>
            <strong>{t("conversationImport.memoryCount", { count: memoryCount })}</strong>
            {instructions > 0 && (
              <small>{t("conversationImport.instructionCount", { count: instructions })}</small>
            )}
          </div>
          <label className={styles.selectRow}>
            <span>{t("conversationImport.memoryTarget")}</span>
            <select
              value={draft.scope}
              onChange={(event) => draft.changeScope(event.target.value === "bot" ? "bot" : "user")}
            >
              <option value="user">{t("appMenu.aboutYou")}</option>
              <option value="bot">{t("conversationImport.botMemory")}</option>
            </select>
          </label>
          <Button
            variant="secondary"
            disabled={!draft.botId}
            onClick={() => draft.review("memory")}
          >
            {t("conversationImport.reviewMemory")}
          </Button>
        </div>
        {draft.memories && <ReviewedChoices value={draft.memories} update={draft.setMemories} />}
      </div>
      {instructions > 0 && (
        <div className={styles.section}>
          <div className={styles.controlRow}>
            <div>
              <strong>{t("conversationImport.persona")}</strong>
              <small>{t("conversationImport.personaNote")}</small>
            </div>
            <Button
              variant="secondary"
              disabled={!draft.botId}
              onClick={() => draft.review("persona")}
            >
              {t("conversationImport.reviewPersona")}
            </Button>
          </div>
          {draft.persona && (
            <>
              <details className={styles.before}>
                <summary>{t("conversationImport.currentPersona")}</summary>
                <p dir="auto">
                  {draft.persona.review.personaBefore || t("conversationImport.noPersona")}
                </p>
              </details>
              <ReviewedChoices value={draft.persona} update={draft.setPersona} />
            </>
          )}
        </div>
      )}
    </>
  );
}

function ReviewedChoices({ value, update }: { value: Selection; update(value: Selection): void }) {
  const t = useT();
  return (
    <>
      {value.review.items.length === 0 && (
        <p className={styles.intro}>{t("conversationImport.noCandidates")}</p>
      )}
      {value.review.items.map((item) => {
        const duplicate = item.outcome === "duplicate";
        return (
          <CheckRow
            key={item.id}
            title={
              <span className={styles.reviewText} dir="auto">
                {item.text}
              </span>
            }
            note={
              duplicate
                ? t("conversationImport.duplicate")
                : item.outcome === "conflict"
                  ? t("conversationImport.conflict", { text: item.existingText ?? "" })
                  : undefined
            }
            checked={value.selected.includes(item.id)}
            disabled={duplicate}
            change={(checked) =>
              update({
                ...value,
                selected: checked
                  ? [...value.selected, item.id]
                  : value.selected.filter((id) => id !== item.id),
              })
            }
          />
        );
      })}
      {value.review.omitted > 0 && (
        <p className={styles.intro}>
          {t("conversationImport.omitted", { count: value.review.omitted })}
        </p>
      )}
    </>
  );
}

function PreviewSkipped({ preview }: { preview: Preview }) {
  const t = useT();
  const fields = [
    ["skippedRecords", preview.skippedRecords],
    ["skippedAttachments", preview.exportDetails?.skippedAttachments],
    ["skippedFiles", preview.exportDetails?.skippedFiles],
  ] as const;
  return (
    <>
      {fields.map(
        ([name, count]) =>
          !!count && (
            <p key={name} className={styles.intro}>
              {t(`conversationImport.${name}`, { count })}
            </p>
          ),
      )}
    </>
  );
}
