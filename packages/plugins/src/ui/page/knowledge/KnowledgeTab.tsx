import type {
  Bot,
  Group,
  KnowledgeDetectResult,
  KnowledgeKind,
  KnowledgeSource,
} from "@pibot/plugins-contract/full";
import { useSettings } from "@pibot/renderer-kit";
import { Button, Icon, IconTile } from "@pibot/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useConnectorAction } from "../../shell/remote.ts";
import { ConnectorFeedback } from "../ConnectorFeedback.tsx";
import styles from "../connections/connections.module.css";
import { Faces, resolveAccess } from "../connections/Faces.tsx";
import { knowledgeError } from "./errors.ts";
import { KnowledgeDetails } from "./KnowledgeDetails.tsx";
import { KIND_ICON, KIND_TONE } from "./kinds.ts";

/** A request from the page's 添加 menu; `at` makes the same kind clickable twice in a row. */
export type KnowledgeAddRequest = { kind: KnowledgeKind; at: number };

/**
 * The 知识库 tab. Each row is a read-only source the person already keeps elsewhere, with
 * who may use it on the right; adding happens here because only this tab knows what a source is.
 */
export function KnowledgeTab({
  sources,
  loading,
  error,
  retry,
  snapshot,
  changed,
  more,
  request,
  requestHandled,
  bots,
  groups,
  detection,
  detecting,
}: {
  sources: KnowledgeSource[];
  loading: boolean;
  error?: Parameters<typeof ConnectorFeedback>[0]["error"];
  retry(): void;
  snapshot: number;
  changed(): void;
  /** Loads the next page; absent once every source is in, so the button never dangles. */
  more?: () => void;
  request?: KnowledgeAddRequest;
  /** The page drops the request once this tab has taken it. */
  requestHandled?(): void;
  bots: Bot[];
  groups: Group[];
  /** What the host found on this computer; absent until the scan answers. */
  detection?: KnowledgeDetectResult;
  detecting: boolean;
}) {
  const { t, language } = useSettings();
  const action = useConnectorAction(changed, knowledgeError);
  const [open, setOpen] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [picking, setPicking] = useState(false);
  // A brief confirmation, not a lasting notice: it fades on its own, as on the page itself.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  const add = useCallback(
    async (kind: KnowledgeKind) => {
      if (kind === "obsidian") {
        setPicking(true);
        // The host owns the folder dialog, so the wait is the person's time, not a slow call.
        const result = await action.run(
          (peer, signal) => peer.call("knowledge.addObsidian", {}, { signal }),
          300_000,
        );
        setPicking(false);
        if (result?.source) setOpen(result.source.id);
        return;
      }
      const result = await action.run((peer, signal) =>
        peer.call("knowledge.addNotion", {}, { signal }),
      );
      // The new source's detail is where the Notion sign-in happens.
      if (result) setOpen(result.source.id);
    },
    [action],
  );
  // A vault the host found comes back as a path; the brain re-checks it against its own
  // scan, so this click still adds only a folder Obsidian lists.
  const addDetected = useCallback(
    async (vaultPath: string) => {
      const result = await action.run((peer, signal) =>
        peer.call("knowledge.addObsidian", { detectedPath: vaultPath }, { signal }),
      );
      if (result?.source) setOpen(result.source.id);
    },
    [action],
  );
  const addRef = useRef(add);
  addRef.current = add;
  const handled = useRef<number>(undefined);
  const handledRef = useRef(requestHandled);
  handledRef.current = requestHandled;
  useEffect(() => {
    if (!request || request.at === handled.current) return;
    handled.current = request.at;
    handledRef.current?.();
    void addRef.current(request.kind);
  }, [request]);
  const row = (source: KnowledgeSource) => {
    const resolved = resolveAccess(
      {
        mode: source.targets.all ? "all" : "selected",
        bots: source.targets.bots,
        groups: source.targets.groups,
      },
      bots,
      groups,
    );
    const used = resolved.bots.length > 0 || resolved.groups.length > 0;
    return (
      <div key={source.id} className={styles.row}>
        <button type="button" className={styles.rowOpen} onClick={() => setOpen(source.id)}>
          <IconTile icon={KIND_ICON[source.kind]} tone={KIND_TONE[source.kind]} size="lg" />
          <span className={styles.rowText}>
            <b>{source.name}</b>
            <div>
              {[
                t(`knowledge.kind.${source.kind}`),
                source.lastUsedAt
                  ? t("knowledge.lastUsed", {
                      time: new Date(source.lastUsedAt).toLocaleString(language),
                    })
                  : t("knowledge.neverUsed"),
              ].join(" · ")}
            </div>
          </span>
        </button>
        {used ? (
          <Faces bots={resolved.bots} groups={resolved.groups} />
        ) : (
          <Button variant="secondary" onClick={() => setOpen(source.id)}>
            {t("connections.action.give")}
          </Button>
        )}
      </div>
    );
  };
  const pending = detection?.obsidian.vaults.filter((vault) => !vault.added) ?? [];
  // The two ways in, as tile rows; shown exactly where the loose buttons used to be.
  const addCard = (
    <div className={styles.softCard}>
      <button
        type="button"
        className={`${styles.tileRow} ${styles.tileAction}`}
        disabled={action.disabled}
        onClick={() => void add("obsidian")}
      >
        <IconTile icon="folder" tone="amber" size="lg" />
        <span className={styles.tileText}>
          <b>{t("knowledge.empty.addObsidian")}</b>
          <small>{t("knowledge.add.obsidianHint")}</small>
        </span>
        <Icon name="chevronRight" size={16} className={styles.tileChevron} />
      </button>
      <button
        type="button"
        className={`${styles.tileRow} ${styles.tileAction}`}
        disabled={action.disabled}
        onClick={() => void add("notion")}
      >
        <IconTile icon="file" tone="teal" size="lg" />
        <span className={styles.tileText}>
          <b>{t("knowledge.empty.addNotion")}</b>
          <small>{t("knowledge.add.notionHint")}</small>
        </span>
        <Icon name="chevronRight" size={16} className={styles.tileChevron} />
      </button>
    </div>
  );
  const detectedRow = (vault: { name: string; path: string }) => (
    <div key={vault.path} className={styles.tileRow}>
      <IconTile icon="folder" tone="amber" size="lg" />
      <span className={styles.tileText}>
        <b>{vault.name}</b>
        <small>{vault.path}</small>
      </span>
      <Button
        variant="secondary"
        disabled={action.disabled}
        onClick={() => void addDetected(vault.path)}
      >
        {t("knowledge.add")}
      </Button>
    </div>
  );
  // A person with no source and nothing on this computer gets the one explanation of what a
  // knowledge source is, plus the two ways in; the scan answer is waited for so it does not flash.
  if (!open && !detecting && !loading && !error && !sources.length && !pending.length)
    return (
      <div className={styles.block}>
        <div className={styles.blankState}>
          <IconTile icon="file" tone="blue" size="lg" />
          <b>{t("knowledge.emptyTitle")}</b>
          <span>{t("knowledge.empty")}</span>
        </div>
        {addCard}
        <ConnectorFeedback loading={false} error={action.error} retry={retry} />
      </div>
    );
  return (
    <>
      <ConnectorFeedback
        loading={loading || picking || detecting}
        error={error ?? action.error}
        retry={retry}
      />
      {picking && (
        <p role="status" className={styles.note}>
          {t("knowledge.picking")}
        </p>
      )}
      {notice && (
        <p role="status" className={styles.note}>
          {t("knowledge.removed", { name: notice })}
        </p>
      )}
      {pending.length > 0 && (
        <section className={styles.block}>
          <h3 className={styles.blockTitle} data-mark="amber">
            <span>{t("knowledge.detected")}</span>
          </h3>
          <div className={styles.softCard} data-tint="amber">
            {pending.map(detectedRow)}
          </div>
          <p className={styles.quiet}>{t("knowledge.detected.note")}</p>
        </section>
      )}
      {sources.length > 0 && (
        <section className={styles.block}>
          <h3 className={styles.blockTitle}>
            <span>{t("knowledge.added")}</span>
          </h3>
          <div className={styles.rows}>{sources.map(row)}</div>
          {more && (
            <div className={styles.actions}>
              <Button variant="secondary" onClick={more}>
                {t("workspace.more")}
              </Button>
            </div>
          )}
          <p className={styles.quiet}>{t("knowledge.readOnlyNote")}</p>
        </section>
      )}
      {!loading && !error && !sources.length && (
        <section className={styles.block}>
          <h3 className={styles.blockTitle} data-mark="teal">
            <span>{t("knowledge.addTitle")}</span>
          </h3>
          {!pending.length && <p className={styles.quiet}>{t("knowledge.empty")}</p>}
          {addCard}
          <p className={styles.quiet}>{t("knowledge.readOnlyNote")}</p>
        </section>
      )}
      {open && (
        <KnowledgeDetails
          key={open}
          id={open}
          snapshot={snapshot}
          changed={changed}
          close={() => setOpen(undefined)}
          removed={(name) => {
            setOpen(undefined);
            setNotice(name);
            changed();
          }}
        />
      )}
    </>
  );
}
