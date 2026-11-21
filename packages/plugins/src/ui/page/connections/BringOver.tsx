import type { TranslationKey } from "@pibot/i18n";
import type { Bot, BringOverReason, BringOverResult } from "@pibot/plugins-contract/full";
import { Overlay, useRpc, useSettings } from "@pibot/renderer-kit";
import type { SkillImportDetails } from "@pibot/skills-contract";
import { Button } from "@pibot/ui";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import styles from "./connections.module.css";
import { PreviewBody } from "./SkillImport.tsx";
import { type DiscoveredRow, offeredIn, sourceMark, type useDiscovery } from "./use-discovery.ts";

type Discovery = ReturnType<typeof useDiscovery>;
export type ListKind = "plugins" | "mcp" | "skills";

/**
 * A bring-over import shares the import dialog's rule — only the codes the brain lists as
 * "nothing was written" mean the copy certainly did not land. A timeout, a dropped connection or a
 * cancel may have committed already, and offering the import again would save a second copy.
 */
const NOTHING_WRITTEN = new Set([
  "skill_import_invalid",
  "skill_import_unsupported",
  "skill_import_too_large",
  "skill_import_file_too_large",
  "skill_import_too_many_files",
  "skill_import_unsafe",
  "skill_import_unreadable",
  "skill_preview_expired",
]);
const FAILED_REASONS: Record<string, BringOverReason> = {
  skill_import_invalid: "invalid",
  skill_import_unsafe: "unsafe",
  skill_import_unsupported: "unsupported",
  skill_import_too_large: "too_large",
  skill_import_file_too_large: "too_large",
  skill_import_too_many_files: "too_large",
};
function failureOf(error: unknown): { reason: BringOverReason; unknown: boolean } {
  const code = error instanceof Error ? (error.message.split("\n")[0] ?? "") : "";
  return { reason: FAILED_REASONS[code] ?? "failed", unknown: !NOTHING_WRITTEN.has(code) };
}

function Sources({ ids, large = false }: { ids: string[]; large?: boolean }) {
  return (
    <span className={styles.sources} aria-hidden="true">
      {ids.map((id) => (
        <span key={id} className={large ? `${styles.source} ${styles.large}` : styles.source}>
          {sourceMark[id] ?? id.slice(0, 2)}
        </span>
      ))}
    </span>
  );
}

/** The strip above a list: shown only while this tab has something left to bring over. */

/** Chinese ListFormat runs Latin names together ("Codex和pi"); keep spaces around 和. */
function toolList(names: string[], language: string) {
  if (!language.startsWith("zh"))
    return new Intl.ListFormat(language, { type: "conjunction" }).format(names);
  return names.length < 2
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join("、")} 和 ${names.at(-1)}`;
}

/** Chinese copy runs Latin words into Han characters ("个MCP没"); pad them with spaces. */
function spaced(word: string, language: string) {
  return language.startsWith("zh") && /^[A-Za-z]/.test(word) ? ` ${word} ` : word;
}

export function BringBar({
  kind,
  rows,
  open,
}: {
  kind: ListKind;
  rows: DiscoveredRow[];
  open(): void;
}) {
  const { t, language } = useSettings();
  const left = rows.filter((row) => row.conflict === "none");
  if (!left.length) return null;
  const sources = [...new Map(left.map((row) => [row.sourceId, row.sourceName]))];
  return (
    <div className={styles.bring}>
      <Sources ids={sources.map(([id]) => id)} />
      <span>
        {t("connections.bringBar", {
          tools: toolList(
            sources.map(([, name]) => name),
            language,
          ),
          count: left.length,
          kind: spaced(t(`connections.kind.${kind}`), language),
        })}
      </span>
      <Button variant="pill" onClick={open}>
        {t("connections.bringAction")}
      </Button>
    </div>
  );
}

/**
 * An empty list on a new install says what will be read and what will not, and reads
 * only after「看看有什么」. Once looked, an empty list says nothing was found.
 */
export function EmptyState({
  kind,
  discovery,
  open,
  addYourself,
}: {
  kind: ListKind;
  discovery: Discovery;
  open(): void;
  addYourself(): void;
}) {
  const { t } = useSettings();
  const consent = discovery.result?.consent === true;
  const tab = kind === "skills" ? "skills" : "mcp";
  const left = discovery.rows().filter((row) => row.conflict === "none" && offeredIn(row, tab));
  const yourself = t(
    kind === "skills"
      ? "connections.empty.writeSkill"
      : kind === "mcp"
        ? "connections.empty.addMcp"
        : "connections.empty.importPlugin",
  );
  if (consent && !discovery.loading && !left.length)
    return (
      <div className={styles.empty}>
        <span>{t("connections.empty.nothing")}</span>
        <div className={styles.actions}>
          <Button variant="secondary" onClick={addYourself}>
            {yourself}
          </Button>
        </div>
      </div>
    );
  return (
    <div className={styles.empty}>
      <Sources ids={["claude-code", "pi", "codex"]} large />
      <b>{t(`connections.empty.${kind}`)}</b>
      <span>{t("connections.empty.body")}</span>
      <div className={styles.actions}>
        <Button
          loading={discovery.busy || discovery.loading}
          onClick={() => {
            if (consent) open();
            // Second-Mac test: agreeing only scanned and the card stayed; open what was found.
            else
              void discovery.consent(true).then((found) => {
                if (
                  found?.sources.some((source) =>
                    source.items.some((item) => item.conflict === "none" && offeredIn(item, tab)),
                  )
                )
                  open();
              });
          }}
        >
          {discovery.loading ? t("connections.looking") : t("connections.empty.look")}
        </Button>
        <Button variant="ghost" onClick={addYourself}>
          {yourself}
        </Button>
      </div>
    </div>
  );
}

/** Grouped by tool, everything new ticked, same-name items left unticked. */
export function BringOverDialog({
  tab,
  discovery,
  bots,
  close,
  done,
}: {
  /** The tab it was opened from; without one (添加 menu) everything found is listed. */
  tab?: "mcp" | "skills";
  discovery: Discovery;
  /** The preview says which Bot the skill lands in, so the name comes from here. */
  bots: Bot[];
  close(): void;
  done(results: BringOverResult[]): void;
}) {
  const { t } = useSettings();
  const { peer } = useRpc();
  const rows = discovery.rows().filter((row) => !tab || offeredIn(row, tab));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const sources = discovery.result?.sources ?? [];
  const consent = discovery.result?.consent === true;
  const count = rows.filter((row) => selected.has(row.key) && row.conflict !== "imported").length;
  const toggle = (key: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const detail = (row: DiscoveredRow) =>
    row.conflict === "imported"
      ? t("connections.dialog.imported")
      : row.conflict === "same_name"
        ? t("connections.dialog.sameName", { name: row.name })
        : [row.description, ...keyNotes(row)].filter(Boolean).join(" · ");
  // Keys by name: written-in ones are saved into Pi Bot, environment ones must be filled in
  // afterwards unless Pi Bot already holds one of that name.
  const keyNotes = (row: DiscoveredRow) => {
    const names = (kind: "stored" | "needed", existing: boolean) =>
      row.secrets
        .filter((secret) => secret.kind === kind && secret.existing === existing)
        .map((secret) => secret.name)
        .join(", ");
    const stored = names("stored", false);
    const needed = names("needed", false);
    const reused = names("needed", true);
    return [
      stored && t("connections.dialog.keysStored", { names: stored }),
      needed && t("connections.dialog.keysNeeded", { names: needed }),
      reused && t("connections.dialog.keysReused", { names: reused }),
    ];
  };
  // Skills take the same preview the file and folder pickers use, so a bring-over is a
  // look (size, licence, compatibility, which Bot) and then a confirm, never a silent create.
  const [previews, setPreviews] = useState<{ row: DiscoveredRow; preview: SkillImportDetails }[]>();
  const [pending, setPending] = useState<{ otherKeys: string[]; count: number }>();
  const [previewFailures, setPreviewFailures] = useState<{ name: string; reason: string }[]>([]);
  const [stage, setStage] = useState<"preview" | "import">();
  const [note, setNote] = useState<{ key: TranslationKey; vars?: Record<string, string> }>();
  // Previews live in the brain for ten minutes and hold an import slot; a dialog that goes away
  // must drop its own, or the next import is refused for no visible reason.
  const outstanding = useRef(new Set<string>());
  const call = useRef<AbortController | undefined>(undefined);
  const alive = useRef(true);
  // A stop may start from a button, Esc, the backdrop or unmount; only the first one owns it.
  const stopping = useRef(false);
  const batch = useRef<string | undefined>(undefined);
  const [stoppingState, setStoppingState] = useState(false);
  const [stopUnconfirmed, setStopUnconfirmed] = useState(false);

  /**
   * Resolves only after the brain released each preview. Aborting a call locally just
   * sends a stop frame, so the dialog cannot treat a dismissed promise as released work.
   */
  const dropPreviews = useCallback(async (): Promise<boolean> => {
    const ids = [...outstanding.current];
    if (!ids.length) return true;
    if (!peer) return false;
    const outcomes = await Promise.allSettled(
      ids.map((previewId) =>
        peer.call("skills.cancelPreview", { previewId }, { timeoutMs: 600_000 }),
      ),
    );
    let released = true;
    for (const [index, outcome] of outcomes.entries()) {
      const previewId = ids[index];
      if (outcome.status === "fulfilled") {
        if (previewId) outstanding.current.delete(previewId);
        continue;
      }
      // An id only leaves once its own cancel answered; keeping it makes a second close retry
      // instead of claiming a cleanup nobody confirmed.
      released = false;
    }
    return released;
  }, [peer]);

  /** Same receipt for the MCP/plugin part of a batch: resolves after its copy or rollback ended. */
  const stopBatch = useCallback(async (): Promise<boolean> => {
    const batchId = batch.current;
    if (!batchId) return true;
    if (!peer) return false;
    try {
      await peer.call("connections.cancelBringOver", { batchId }, { timeoutMs: 600_000 });
      if (batch.current === batchId) batch.current = undefined;
      return true;
    } catch {
      // No answer means we cannot say it stopped; the caller shows that instead of claiming it.
      return false;
    }
  }, [peer]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      call.current?.abort();
      // The dialog is gone, but these keep waiting so a dismissed window hides no live work.
      void dropPreviews();
      void stopBatch();
    };
  }, [dropPreviews, stopBatch]);

  const requestClose = () => {
    if (stopping.current) return;
    const hasWork = !!stage || !!call.current || outstanding.current.size > 0 || !!batch.current;
    if (!hasWork) {
      close();
      return;
    }
    // Same rule as the import dialog: ask the brain to stop, and close only after every receipt.
    stopping.current = true;
    setStoppingState(true);
    call.current?.abort();
    void (async () => {
      const [previewsDropped, batchStopped] = await Promise.all([dropPreviews(), stopBatch()]);
      if (!alive.current) return;
      if (previewsDropped && batchStopped) {
        close();
        return;
      }
      // Closing here would claim a cleanup nobody confirmed; the warning stays in front instead.
      stopping.current = false;
      setStoppingState(false);
      setStopUnconfirmed(true);
    })();
  };

  const settle = () => {
    if (!alive.current) return;
    setStage(undefined);
  };

  const chosenKeys = () =>
    rows.filter((row) => selected.has(row.key) && row.conflict !== "imported");

  const submit = async () => {
    if (!peer || stopping.current || call.current || batch.current || stopUnconfirmed) return;
    const chosen = chosenKeys();
    const skills = chosen.filter((row) => row.kind === "skill");
    const otherKeys = chosen.filter((row) => row.kind !== "skill").map((row) => row.key);
    setNote(undefined);
    setPreviewFailures([]);
    if (!skills.length) {
      // MCP servers and plugins keep their own validated import; only skills preview here. They
      // still belong to one batch: stopping aborts this call and waits for the same receipt.
      const controller = new AbortController();
      call.current = controller;
      const batchId = globalThis.crypto.randomUUID();
      batch.current = batchId;
      setStage("import");
      try {
        const results = await discovery.bringOver(otherKeys, controller.signal, batchId);
        if (!alive.current || controller.signal.aborted) return;
        // The hook can return undefined after a local abort or transport failure. Only a result
        // from the owner (or a successful stop receipt) releases this batch's identity.
        if (!results) {
          setStopUnconfirmed(true);
          return;
        }
        if (batch.current === batchId) batch.current = undefined;
        done(results);
      } finally {
        if (call.current === controller) call.current = undefined;
        settle();
      }
      return;
    }
    const controller = new AbortController();
    call.current = controller;
    // Named before dispatch: the first preview has no id yet, and a stop during it must still be
    // able to wait for the batch to unwind.
    const previewBatchId = globalThis.crypto.randomUUID();
    batch.current = previewBatchId;
    setStage("preview");
    setPending({ otherKeys, count: chosen.length });
    try {
      const { results } = await peer.call(
        "connections.previewBringOver",
        { keys: skills.map((row) => row.key), batchId: previewBatchId },
        // The brain allows each skill five minutes (big packages scan thousands of files).
        { timeoutMs: (skills.length * 5 + 1) * 60_000, signal: controller.signal },
      );
      // The preview call has returned; its batch has nothing left to wait for.
      if (batch.current === previewBatchId) batch.current = undefined;
      // Record the ids before checking liveness: a dialog that went away while the answer was in
      // flight would otherwise drop these previews with nobody left holding their ids.
      for (const result of results)
        if (result.outcome === "previewed") outstanding.current.add(result.preview.previewId);
      if (!alive.current || controller.signal.aborted) {
        void dropPreviews();
        return;
      }
      const ready: { row: DiscoveredRow; preview: SkillImportDetails }[] = [];
      const failed: { name: string; reason: string }[] = [];
      for (const result of results) {
        if (result.outcome === "previewed") {
          const row = skills.find((candidate) => candidate.key === result.key) ?? skills[0];
          if (!row) continue;
          ready.push({ row, preview: result.preview });
        } else {
          failed.push({
            name: rows.find((row) => row.key === result.key)?.name ?? "",
            reason: t(`connections.reason.${result.reason}` as TranslationKey),
          });
        }
      }
      setPreviews(ready);
      setPreviewFailures(failed);
    } catch {
      if (controller.signal.aborted || !alive.current) return;
      setPending(undefined);
      setNote({ key: "connections.reason.failed" });
    } finally {
      if (call.current === controller) call.current = undefined;
      settle();
    }
  };

  const importAll = async () => {
    if (
      !peer ||
      !previews ||
      !pending ||
      stopping.current ||
      call.current ||
      batch.current ||
      stopUnconfirmed
    )
      return;
    const controller = new AbortController();
    call.current = controller;
    setStage("import");
    setNote(undefined);
    const results: BringOverResult[] = [];
    let unknownName: string | undefined;
    try {
      for (const { row, preview } of previews) {
        try {
          const skill = await peer.call(
            "skills.import",
            { previewId: preview.previewId },
            { timeoutMs: 125 * 60_000, signal: controller.signal },
          );
          if (!alive.current || controller.signal.aborted) return;
          outstanding.current.delete(preview.previewId);
          results.push({ key: row.key, outcome: "imported", name: skill.name });
        } catch (error) {
          if (controller.signal.aborted || !alive.current) return;
          const { reason, unknown } = failureOf(error);
          results.push({ key: row.key, outcome: "failed", reason });
          if (unknown) {
            // The copy may have landed. Stop the batch and say so, so nobody imports the
            // same skill twice and ends up with a second copy under a new name.
            unknownName = row.name;
            break;
          }
        }
      }
      if (unknownName) {
        setNote({ key: "connections.preview.uncertain", vars: { name: unknownName } });
        return;
      }
      if (pending.otherKeys.length) {
        const batchId = globalThis.crypto.randomUUID();
        batch.current = batchId;
        const rest = await discovery.bringOver(pending.otherKeys, controller.signal, batchId);
        if (!alive.current || controller.signal.aborted) return;
        if (!rest) {
          setStopUnconfirmed(true);
          return;
        }
        if (batch.current === batchId) batch.current = undefined;
        results.push(...rest);
      }
      if (!alive.current || controller.signal.aborted) return;
      const released = await dropPreviews();
      if (!alive.current || controller.signal.aborted) return;
      if (!released) {
        setStopUnconfirmed(true);
        return;
      }
      done(results);
    } finally {
      if (call.current === controller) call.current = undefined;
      settle();
    }
  };

  return (
    <Overlay
      icon="send"
      tone="pink"
      title={previews ? t("connections.preview.title") : t("connections.dialog.title")}
      close={requestClose}
      // A stop is already under way once the receipts are being awaited; no second start.
      busy={stoppingState}
    >
      {stopUnconfirmed && (
        <p role="alert" className={styles.error}>
          {t("skills.preview.stopUnconfirmed")}
        </p>
      )}
      {previews ? (
        <>
          {previews.map(({ row, preview }) => (
            <PreviewBody
              key={preview.previewId}
              details={preview}
              source={row.sourceName}
              botName={bots.find((bot) => bot.id === preview.botId)?.name ?? ""}
            />
          ))}
          {previewFailures.map((failure) => (
            <p key={failure.name} role="alert" className={styles.error}>
              {t("connections.preview.failed", failure)}
            </p>
          ))}
          {note && (
            <p role="alert" className={styles.error}>
              {t(note.key, note.vars)}
            </p>
          )}
          <div className={styles.dialogFoot}>
            <span>{t("connections.preview.note")}</span>
            <Button variant="secondary" onClick={requestClose}>
              {t(note ? "skills.preview.close" : "common.cancel")}
            </Button>
            {!note && (
              <Button
                loading={stage === "import"}
                disabled={
                  stage !== undefined || !previews.length || stoppingState || stopUnconfirmed
                }
                onClick={() => void importAll()}
              >
                {t("connections.dialog.submit", {
                  count: previews.length + (pending?.otherKeys.length ?? 0),
                })}
              </Button>
            )}
          </div>
        </>
      ) : (
        <>
          {!consent ? (
            <div className={styles.empty}>
              <span>{t("connections.empty.body")}</span>
              <Button loading={discovery.busy} onClick={() => void discovery.consent(true)}>
                {t("connections.empty.look")}
              </Button>
            </div>
          ) : (
            <div className={styles.dialogList}>
              {discovery.loading && <p className={styles.status}>{t("connections.looking")}</p>}
              {sources.map((source) => {
                const items = rows.filter((row) => row.sourceId === source.id);
                return (
                  <Fragment key={source.id}>
                    <div className={styles.group}>
                      <span className={styles.source} aria-hidden="true">
                        {sourceMark[source.id]}
                      </span>
                      {source.name}
                      {!items.length && (
                        <span className={styles.note}>
                          {t(
                            source.installed
                              ? "connections.dialog.none"
                              : "connections.dialog.notInstalled",
                          )}
                        </span>
                      )}
                    </div>
                    <div>
                      {items.map((row) => (
                        <label key={row.key} className={styles.check}>
                          <input
                            type="checkbox"
                            checked={row.conflict !== "imported" && selected.has(row.key)}
                            disabled={row.conflict === "imported" || discovery.busy}
                            onChange={() => toggle(row.key)}
                          />
                          <span>
                            {row.name}
                            <small>{detail(row)}</small>
                          </span>
                          <span className={styles.tag}>
                            {t(
                              row.kind === "skill"
                                ? "connections.tab.skills"
                                : row.kind === "mcp"
                                  ? "connections.tab.mcp"
                                  : row.contains?.mcp && row.contains.skills
                                    ? "connections.kind.pluginBoth"
                                    : row.contains?.mcp
                                      ? "connections.kind.pluginMcp"
                                      : row.contains?.skills
                                        ? "connections.kind.pluginSkills"
                                        : "connections.tab.plugins",
                            )}
                          </span>
                        </label>
                      ))}
                    </div>
                  </Fragment>
                );
              })}
            </div>
          )}
          {discovery.error && (
            <p role="alert" className={styles.error}>
              {t(discovery.error)}
            </p>
          )}
          <div className={styles.dialogFoot}>
            <span>{t("connections.dialog.footer")}</span>
            {consent && (
              <>
                <Button
                  variant="ghost"
                  disabled={discovery.busy}
                  onClick={() => void discovery.consent(false).then(() => requestClose())}
                >
                  {t("connections.dialog.stop")}
                </Button>
                <Button
                  variant="ghost"
                  disabled={discovery.busy || discovery.loading}
                  onClick={() => void discovery.load()}
                >
                  {t("connections.dialog.rescan")}
                </Button>
              </>
            )}
            <Button variant="secondary" disabled={discovery.busy} onClick={requestClose}>
              {t("common.cancel")}
            </Button>
            <Button
              loading={stage !== undefined}
              disabled={
                !consent || !count || stage !== undefined || stoppingState || stopUnconfirmed
              }
              onClick={() => void submit()}
            >
              {t("connections.dialog.submit", { count })}
            </Button>
          </div>
        </>
      )}
    </Overlay>
  );
}

/** One line per outcome after a bring-over; failures name the item and the reason. */
export function BringOverSummary({
  results,
  rows,
}: {
  results: BringOverResult[];
  rows: DiscoveredRow[];
}) {
  const { t } = useSettings();
  const imported = results.filter((result) => result.outcome === "imported").length;
  const failed = results.filter((result) => result.outcome === "failed");
  return (
    <>
      {imported > 0 && (
        <p role="status" className={styles.status}>
          {t("connections.result.done", { count: imported })}
        </p>
      )}
      {failed.map((result) => (
        <p key={result.key} role="alert" className={styles.error}>
          {t("connections.result.failed", {
            name: rows.find((row) => row.key === result.key)?.name ?? result.name ?? "",
            reason: t(`connections.reason.${result.reason ?? "failed"}`),
          })}
        </p>
      ))}
    </>
  );
}
