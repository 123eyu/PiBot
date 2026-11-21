import type {
  ConnectorAccess,
  KnowledgeAccount,
  KnowledgeSource,
} from "@pibot/plugins-contract/full";
import type { Peer } from "@pibot/renderer-kit";
import { useRpc, useSettings, useWorkspace } from "@pibot/renderer-kit";
import { Button, Chip, IconTile } from "@pibot/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useConnectorAction, useConnectorRead } from "../../shell/remote.ts";
import { ConnectorFeedback } from "../ConnectorFeedback.tsx";
import { ConnectorPanel } from "../ConnectorPanel.tsx";
import { flipAccess } from "../connections/access-grant.ts";
import styles from "../connections/connections.module.css";
import { FacePicker } from "../connections/Faces.tsx";
import { knowledgeError } from "./errors.ts";
import { KIND_ICON, KIND_TONE } from "./kinds.ts";

/** Statuses where the Notion connection still needs the person's browser sign-in. */
const NEEDS_SIGN_IN = ["needs_setup", "needs_auth", "error", "disabled"];

/**
 * One knowledge source — where it reads from, who may use it, and how to forget it. A Notion
 * source owns a remote MCP connection, so signing in stays here instead of sending the person to
 * the connection pages, where that installation would look like any other import.
 */
export function KnowledgeDetails({
  id,
  snapshot,
  changed,
  close,
  removed,
}: {
  id: string;
  snapshot: number;
  changed(): void;
  close(): void;
  removed(name: string): void;
}) {
  const { t, language } = useSettings();
  const workspace = useWorkspace();
  const detail = useConnectorRead(
    // biome-ignore lint/correctness/useExhaustiveDependencies: a new snapshot re-reads the saved targets.
    useCallback(
      (peer: Peer, signal: AbortSignal) => peer.call("knowledge.get", { id }, { signal }),
      [id, snapshot],
    ),
    knowledgeError,
  );
  const bots = workspace.bots.filter((bot) => !bot.archivedAt);
  const groups = workspace.groups.filter((group) => !group.archivedAt);
  const source = detail.value?.source;
  const origin = detail.value?.origin;
  const connectorId = origin?.kind === "notion" ? origin.connectorId : undefined;
  const connection = useConnectorRead(
    // biome-ignore lint/correctness/useExhaustiveDependencies: a new snapshot re-reads the connection's status.
    useCallback(
      (peer: Peer, signal: AbortSignal) =>
        connectorId
          ? peer.call("connectors.get", { id: connectorId }, { signal })
          : Promise.resolve(undefined),
      [connectorId, snapshot],
    ),
    knowledgeError,
  );
  const action = useConnectorAction(changed, knowledgeError);
  const [confirming, setConfirming] = useState(false);
  const [authorization, setAuthorization] = useState<{
    authorizationId: string;
    expiresAt: string;
  }>();
  const status = connection.value?.connector.status;
  // A sign-in finished here re-reads the account even when one is stored (a different
  // workspace may have been chosen); 重试 does the same.
  const signingIn = useRef(false);
  const [force, setForce] = useState(0);
  const retryAccount = useCallback(() => setForce((n) => n + 1), []);
  useEffect(() => {
    if (status !== "ready" && status !== "idle") return;
    setAuthorization(undefined);
    if (signingIn.current) {
      signingIn.current = false;
      setForce((n) => n + 1);
    }
  }, [status]);
  const authorize = async () => {
    const row = connection.value?.connector;
    if (!row || action.disabled) return;
    // The host waits for native consent; both deadlines must outlive that wait.
    const timeoutMs = 660_000;
    const result = await action.run(
      (peer, signal) =>
        peer.call(
          "connectors.authorize",
          { id: row.id, expectedRevision: row.revision },
          { signal, timeoutMs },
        ),
      timeoutMs,
    );
    if (result) {
      signingIn.current = true;
      setAuthorization(result);
    }
  };
  // 「所有 Bot」 is one stored flag; the picker shows it as every Bot switched on and
  // the first click that removes one writes the explicit list, exactly like MCP's who-can-use.
  const access: ConnectorAccess = source
    ? {
        mode: source.targets.all ? "all" : "selected",
        bots: source.targets.bots,
        groups: source.targets.groups,
      }
    : { mode: "selected", bots: [], groups: [] };
  const toggle = (kind: "bot" | "group", targetId: string) => {
    if (!source || action.disabled) return;
    const next = flipAccess(
      access,
      bots.map((bot) => bot.id),
      { kind, id: targetId },
    );
    void action.run((peer, signal) =>
      peer.call(
        "knowledge.update",
        {
          id: source.id,
          name: source.name,
          targets: { all: false, bots: next.bots, groups: next.groups },
        },
        { signal },
      ),
    );
  };
  const remove = async () => {
    if (!source || action.disabled) return;
    const result = await action.run((peer, signal) =>
      peer.call("knowledge.remove", { id: source.id }, { signal }),
    );
    if (result) removed(source.name);
  };
  const lastUsed = (value: KnowledgeSource) =>
    value.lastUsedAt
      ? t("knowledge.lastUsed", { time: new Date(value.lastUsedAt).toLocaleString(language) })
      : t("knowledge.neverUsed");
  const signedIn = status === "ready" || status === "idle";
  return (
    <ConnectorPanel
      title={source?.name ?? t("knowledge.category")}
      close={close}
      busy={action.busy}
    >
      <ConnectorFeedback
        loading={detail.loading}
        error={detail.error ?? action.error}
        retry={detail.refresh}
      />
      {source && (
        <>
          <div className={styles.panelHead}>
            <IconTile icon={KIND_ICON[source.kind]} tone={KIND_TONE[source.kind]} size="lg" />
            <div className={styles.tileText}>
              <small>{t(`knowledge.kind.${source.kind}`)}</small>
            </div>
            {status && (
              <Chip tone={signedIn ? "ok" : "warn"}>{t(`connectors.status.${status}`)}</Chip>
            )}
          </div>
          <section className={styles.block}>
            <h3 className={styles.blockTitle}>
              <span>{t("knowledge.origin")}</span>
            </h3>
            <div className={styles.softCard}>
              <div className={styles.tileRow}>
                <IconTile icon={KIND_ICON[source.kind]} tone={KIND_TONE[source.kind]} size="lg" />
                <span className={styles.tileText}>
                  {origin?.kind === "obsidian" ? (
                    <>
                      <b>{t("knowledge.kind.obsidian")}</b>
                      <small className={styles.mono}>{origin.path}</small>
                    </>
                  ) : (
                    <b>{t("knowledge.origin.notion")}</b>
                  )}
                </span>
              </div>
              {origin?.kind === "notion" &&
                (authorization ? (
                  <div className={styles.tileRow}>
                    <span className={styles.tileText} role="status">
                      {t("connectors.authorizing")}
                    </span>
                    <Button
                      variant="secondary"
                      disabled={action.disabled}
                      onClick={() =>
                        void action.run(async (peer, signal) => {
                          await peer.call(
                            "connectors.cancelAuthorization",
                            { authorizationId: authorization.authorizationId },
                            { signal },
                          );
                          signingIn.current = false;
                          setAuthorization(undefined);
                        })
                      }
                    >
                      {t("connectors.cancelAuth")}
                    </Button>
                  </div>
                ) : (
                  status &&
                  NEEDS_SIGN_IN.includes(status) && (
                    <div className={styles.tileRow}>
                      <IconTile icon="key" tone="violet" size="lg" />
                      <span className={styles.tileText}>
                        <small>{t("knowledge.notionNote")}</small>
                      </span>
                      <Button
                        variant="secondary"
                        loading={action.busy}
                        disabled={action.disabled || !connection.value}
                        onClick={() => void authorize()}
                      >
                        {t("knowledge.notionConnect")}
                      </Button>
                    </div>
                  )
                ))}
            </div>
            {origin?.kind === "notion" &&
              !authorization &&
              !(status && NEEDS_SIGN_IN.includes(status)) && (
                <p className={styles.quiet}>{t("knowledge.notionNote")}</p>
              )}
          </section>
          {origin?.kind === "notion" && (
            <NotionAccount id={source.id} status={status} force={force} retry={retryAccount} />
          )}
          <section className={styles.block}>
            <h3 className={styles.blockTitle} data-mark="violet">
              <span>{t("connections.panel.who")}</span>
            </h3>
            <div className={styles.softCard}>
              <div className={styles.tileRow}>
                <FacePicker
                  bots={bots}
                  groups={groups}
                  isOn={(kind, faceId) =>
                    kind === "bot"
                      ? source.targets.all || source.targets.bots.includes(faceId)
                      : !source.targets.all && source.targets.groups.includes(faceId)
                  }
                  toggle={toggle}
                  disabled={action.disabled}
                />
              </div>
            </div>
            <p className={styles.quiet}>{t("connections.panel.whoNote")}</p>
          </section>
          <section className={styles.block}>
            <h3 className={styles.blockTitle} data-mark="teal">
              <span>{t("connectors.recentUse")}</span>
            </h3>
            <div className={styles.softCard}>
              <div className={styles.tileRow}>
                <IconTile icon="clock" tone="teal" size="lg" />
                <span className={styles.tileText}>{lastUsed(source)}</span>
              </div>
            </div>
            <p className={styles.quiet}>{t("knowledge.readOnlyNote")}</p>
          </section>
          <div className={styles.softCard}>
            {confirming ? (
              <div className={styles.tileRow}>
                <IconTile icon="trash" tone="red" size="lg" />
                <span className={styles.tileText}>
                  <b>{t("knowledge.removeConfirm", { name: source.name })}</b>
                  <small>{t("knowledge.removeNote")}</small>
                </span>
                <Button
                  variant="secondary"
                  disabled={action.busy}
                  onClick={() => setConfirming(false)}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  className={styles.dangerButton}
                  loading={action.busy}
                  disabled={action.disabled}
                  onClick={() => void remove()}
                >
                  {t("knowledge.remove")}
                </Button>
              </div>
            ) : (
              <button
                type="button"
                className={`${styles.tileRow} ${styles.tileAction}`}
                data-danger=""
                onClick={() => setConfirming(true)}
              >
                <IconTile icon="trash" tone="red" size="lg" />
                <span className={styles.tileText}>
                  <b>{t("knowledge.remove")}</b>
                  <small>{t("knowledge.removeNote")}</small>
                </span>
              </button>
            )}
          </div>
        </>
      )}
    </ConnectorPanel>
  );
}

/**
 * Which Notion account the source is signed in as. Read lazily when the panel opens (the
 * brain answers the stored account, or asks Notion once), again when the sign-in status changes,
 * and with `refresh` after a sign-in finished here or on 重试. The email is shown, never logged.
 */
function NotionAccount({
  id,
  status,
  force,
  retry,
}: {
  id: string;
  status?: string;
  force: number;
  retry(): void;
}) {
  const { t } = useSettings();
  const { peer } = useRpc();
  const [state, setState] = useState<{ account?: KnowledgeAccount | null; failed?: boolean }>();
  useEffect(() => {
    if (!peer || !status) return;
    const owner = new AbortController();
    setState(undefined);
    // The brain bounds the remote call at 30 s; this deadline only has to outlive it.
    const signal = AbortSignal.any([owner.signal, AbortSignal.timeout(45_000)]);
    void peer
      .call("knowledge.account", { id, refresh: force > 0 }, { signal, timeoutMs: 45_000 })
      .then(
        (result) => {
          if (!owner.signal.aborted) setState({ account: result.account });
        },
        () => {
          if (!owner.signal.aborted) setState({ failed: true });
        },
      );
    return () => owner.abort();
  }, [peer, id, status, force]);
  const account = state?.account;
  if (account === null) return null;
  const reason = state?.failed
    ? "failed"
    : account?.status === "unavailable"
      ? account.reason
      : null;
  return (
    <section className={styles.block}>
      <h3 className={styles.blockTitle} data-mark="green">
        <span>{t("knowledge.account")}</span>
      </h3>
      <div className={styles.softCard}>
        {!state ? (
          <div className={styles.tileRow}>
            <IconTile icon="user" tone="neutral" size="lg" />
            <span className={styles.tileText} role="status">
              <small>{t("knowledge.account.loading")}</small>
            </span>
          </div>
        ) : account?.status === "ok" ? (
          <div className={styles.tileRow}>
            <IconTile icon="user" tone="green" size="lg" />
            <dl className={`${styles.facts} ${styles.tileText}`}>
              {account.workspace && (
                <>
                  <dt>{t("knowledge.account.workspace")}</dt>
                  <dd>{account.workspace}</dd>
                </>
              )}
              {account.name && (
                <>
                  <dt>{t("knowledge.account.name")}</dt>
                  <dd>{account.name}</dd>
                </>
              )}
              {account.email && (
                <>
                  <dt>{t("knowledge.account.email")}</dt>
                  <dd>{account.email}</dd>
                </>
              )}
            </dl>
          </div>
        ) : (
          <div className={styles.tileRow}>
            <IconTile icon="user" tone="neutral" size="lg" />
            <span className={styles.tileText}>
              <b>{t("knowledge.account.unavailable")}</b>
              {reason && <small>{t(`knowledge.account.reason.${reason}`)}</small>}
            </span>
            {reason !== "signin" && (
              <Button variant="secondary" onClick={retry}>
                {t("common.retry")}
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
