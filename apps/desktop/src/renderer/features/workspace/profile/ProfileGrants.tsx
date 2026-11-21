import type { Grant } from "@pibot/protocol";
import {
  type Peer,
  botPanelStyles as styles,
  useRpc,
  useRpcEvent,
  useT,
  waitRpc,
} from "@pibot/renderer-kit";
import {
  invalidReasonKey,
  operationText,
  usePages,
  useRoutineAction,
  useRoutineNavigation,
  useRoutineRefresh,
} from "@pibot/routines/ui";
import { Button, IconTile } from "@pibot/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { grantLabel } from "../../settings/permissions/grants.tsx";
import { CATEGORY_LOOK } from "../../settings/permissions/permission-operations.tsx";
import { usePagedList } from "../../settings/use-paged-list.ts";

/**
 * Per-Bot permissions live only here (owner decision 2026-10-14): the Bot's remembered grants
 * and its scheduled-task preauthorizations, each revocable and paged. One card each, and
 * a list with nothing in it is not shown at all.
 */
export function ProfileGrants({ botId }: { botId: string }) {
  return (
    <>
      <Grants botId={botId} />
      <Preauthorizations botId={botId} />
    </>
  );
}

export function Grants({ botId, groupId }: { botId?: string; groupId?: string }) {
  const { peer } = useRpc();
  const t = useT();
  const fetchPage = useCallback(
    (before?: string) =>
      peer
        ? peer.call("grants.list", { limit: 50, botId, groupId, ...(before ? { before } : {}) })
        : Promise.reject(new Error("Disconnected")),
    [peer, botId, groupId],
  );
  const list = usePagedList(fetchPage);
  useRpcEvent("drafts.changed", () => {
    void list.load();
  });
  useRpcEvent("secrets.changed", () => {
    void list.load();
  });
  useRpcEvent("connectors.changed", () => {
    void list.load();
  });
  useRpcEvent("approval.resolved", () => {
    void list.load();
  });
  useRpcEvent("permissions.changed", (event) => {
    if (
      (!event.botId && !event.groupId) ||
      (groupId ? event.groupId === groupId : event.botId === botId)
    )
      void list.load();
  });
  useRpcEvent("changes.changed", (event) => {
    if (event.reason !== "folder") return;
    if (
      !event.conversationKey ||
      event.conversationKey === (groupId ? `group:${groupId}` : `dm:${botId}`)
    )
      void list.load();
  });
  useRpcEvent("sidebar.changed", () => {
    void list.load();
  });
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState(false);
  const alive = useRef(0);
  const locked = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: invalidate in-flight revocations when the peer changes
  useEffect(() => {
    alive.current++;
    locked.current = false;
    setBusy(undefined);
    return () => {
      alive.current++;
    };
  }, [peer, botId, groupId]);
  const revoke = async (id: string) => {
    if (!peer || locked.current) return;
    const version = alive.current;
    locked.current = true;
    setBusy(id);
    setError(false);
    try {
      await peer.call("grants.revoke", { id });
      if (version === alive.current) await list.load();
    } catch {
      if (version === alive.current) setError(true);
    } finally {
      if (version === alive.current) {
        locked.current = false;
        setBusy(undefined);
      }
    }
  };
  const connectorNames = useConnectorNames(list.items);
  const failed = list.error || error;
  if (!list.items.length && !failed) return null;
  const title = (grant: Grant) => {
    const scope = grant.scope;
    if (scope.kind === "login") return t("credentials.grantLabel", { site: grantLabel(grant, t) });
    if (scope.kind === "submit")
      return t("permissions.submitScope", { site: grantLabel(grant, t) });
    if (scope.kind === "web_read") return t("permissions.webReadScope");
    if (scope.kind === "paid_image")
      return t("permissions.paidImageScope", { model: grantLabel(grant, t) });
    if (scope.kind === "connector")
      return connectorNames.get(scope.connectorId) ?? grantLabel(grant, t);
    if ((scope.kind === "programs" || scope.kind === "workplace") && scope.topicId)
      return grantLabel(grant, t);
    const path =
      scope.kind === "folder" ? scope.path : scope.kind === "workplace" ? scope.root : "";
    if (path) {
      const label = BOT_HOME.test(path) ? t("folders.home") : shortPath(path);
      return scope.kind === "workplace" ? t("permissions.singleRootScope", { root: label }) : label;
    }
    return grantLabel(grant, t);
  };
  const grouped = new Map<string, Grant[]>();
  for (const grant of list.items) {
    const key = ["connector", "send_target", "secret"].includes(grant.scope.kind)
      ? grant.scope.kind
      : "other";
    const rows = grouped.get(key) ?? [];
    rows.push(grant);
    grouped.set(key, rows);
  }
  return (
    <section className={styles.section}>
      <h2>
        {t("panel.grants")} · {list.items.length}
        {list.hasMore ? "+" : ""}
      </h2>
      {!!list.items.length && (
        <div className={styles.card}>
          {[...grouped].map(([kind, rows]) => (
            <div key={kind}>
              {/* One kind needs no sub-heading; the section title already says what they are. */}
              {grouped.size > 1 && (
                <div className={styles.cardGroupTitle}>
                  {t(
                    kind === "connector"
                      ? "profile.connections"
                      : kind === "secret"
                        ? "connectors.secrets"
                        : kind === "send_target"
                          ? "profile.sendTargets"
                          : "profile.otherGrants",
                  )}
                </div>
              )}
              {rows.map((grant) => (
                <div className={styles.cardRow} key={grant.id}>
                  <IconTile
                    icon={CATEGORY_LOOK[grant.category][0]}
                    tone={CATEGORY_LOOK[grant.category][1]}
                    size="lg"
                  />
                  <span className={styles.rowText}>
                    <strong title={grantLabel(grant, t)}>{title(grant)}</strong>
                    <small>
                      {t(`permissions.category.${grant.category}`)} ·{" "}
                      {t("permissions.level.always")}
                    </small>
                  </span>
                  <Button
                    variant="pill"
                    className={styles.menuTrigger}
                    disabled={!peer || !!busy || list.loading}
                    loading={busy === grant.id}
                    onClick={() => void revoke(grant.id)}
                  >
                    {t("permissions.revoke")}
                  </Button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      <p className={styles.note}>{t("workspace.grantsNote")}</p>
      {failed && (
        <p role="alert" className={styles.error}>
          {t("permissions.grantsError")}{" "}
          <Button
            variant="pill"
            disabled={list.loading || !!busy}
            onClick={() => {
              setError(false);
              void list.load();
            }}
          >
            {t("common.retry")}
          </Button>
        </p>
      )}
      {list.hasMore && (
        <Button
          variant="pill"
          className={styles.more}
          disabled={list.loading || !!busy}
          onClick={() => void list.load(true)}
        >
          {t("permissions.loadMore")}
        </Button>
      )}
    </section>
  );
}

// A Bot's own folder (<data>/bots/<id>/home) is named like the chat header names it.
const BOT_HOME = /[\\/]bots[\\/][0-9a-f-]{36}[\\/]home[\\/]?$/i;

/** The last two segments of a long path; the full path stays in the row's tooltip. */
function shortPath(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 3) return path;
  const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  return `…${sep}${parts.slice(-2).join(sep)}`;
}

/** Connector grants store an id; show the connector's name once it is known. */
function useConnectorNames(grants: readonly Grant[]) {
  const { peer } = useRpc();
  const ids = useMemo(
    () =>
      [
        ...new Set(
          grants.flatMap((g) => (g.scope.kind === "connector" ? [g.scope.connectorId] : [])),
        ),
      ].sort(),
    [grants],
  );
  const key = ids.join(",");
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `ids`
  useEffect(() => {
    if (!peer || !ids.length) return;
    const controller = new AbortController();
    void Promise.all(
      ids.map((id) =>
        peer
          .call("connectors.get", { id }, { signal: controller.signal })
          .then((row) => [id, row.connector.name] as const)
          // A deleted connector keeps showing its id; the grant can still be revoked.
          .catch(() => undefined),
      ),
    ).then((rows) => {
      if (!controller.signal.aborted) setNames(new Map(rows.filter((row) => row !== undefined)));
    });
    return () => controller.abort();
  }, [peer, key]);
  return names;
}

function Preauthorizations({ botId }: { botId: string }) {
  const { peer } = useRpc();
  const t = useT();
  const { openRoutines } = useRoutineNavigation();
  const load = useCallback(
    async (peer: Peer, before?: string, parent?: AbortSignal) => {
      const signal = parent ?? AbortSignal.timeout(30_000);
      const records = await waitRpc(
        () => peer.call("routines.preauth.list", { botId, before, limit: 50 }),
        signal,
      );
      const names = new Map<string, string>();
      for (const p of records)
        if (!names.has(p.routineId)) {
          signal.throwIfAborted();
          const routine = await waitRpc(
            () => peer.call("routines.get", { id: p.routineId }),
            signal,
          );
          if (routine.id !== p.routineId || routine.botId !== botId)
            throw new Error("Preauthorization owner changed");
          names.set(p.routineId, routine.name);
        }
      return records.map((p) => ({
        ...p,
        name: names.get(p.routineId) ?? t("workspace.botUnknown"),
      }));
    },
    [botId, t],
  );
  const list = usePages(load);
  const action = useRoutineAction();
  useRoutineRefresh(list.refresh, botId);
  useRpcEvent("permissions.changed", () => list.refresh());
  const failed = list.error || action.error;
  if (!list.rows.length && !failed) return null;
  return (
    <section className={styles.section}>
      <h2>
        {t("routines.preauthGroup")} · {list.rows.length}
        {list.more ? "+" : ""}
      </h2>
      {!!list.rows.length && (
        <div className={styles.card}>
          {list.rows.map((p) => (
            <div key={p.id} className={styles.cardRow}>
              <IconTile
                icon={CATEGORY_LOOK[p.operation.category][0]}
                tone={CATEGORY_LOOK[p.operation.category][1]}
                size="lg"
              />
              <button
                type="button"
                className={`${styles.rowText} ${styles.rowButton}`}
                aria-label={`${p.name} · ${t("routines.reviewTask")}`}
                onClick={() => openRoutines(p.routineId)}
              >
                <strong>
                  {p.name} · {t(`permissions.category.${p.operation.category}`)}
                </strong>
                <small>{operationText(p.operation, t)}</small>
                {p.invalidReason && <small>{t(invalidReasonKey(p.invalidReason))}</small>}
              </button>
              <Button
                variant="pill"
                className={styles.menuTrigger}
                disabled={action.disabled}
                onClick={() => {
                  if (peer)
                    void action.run(async (signal) => {
                      await waitRpc(
                        () => peer.call("routines.preauth.revoke", { id: p.id }),
                        signal,
                      );
                      signal.throwIfAborted();
                      list.refresh();
                    });
                }}
              >
                {t("permissions.revoke")}
              </Button>
            </div>
          ))}
        </div>
      )}
      <p className={styles.note}>{t("routines.preauthGroupNote")}</p>
      {failed && (
        <p role="alert" className={styles.error}>
          {t(action.error ?? list.error ?? "routines.failed")}{" "}
          <Button variant="pill" disabled={action.busy} onClick={list.refresh}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {list.more && (
        <Button
          variant="pill"
          className={styles.more}
          disabled={list.loading}
          onClick={() => void list.next()}
        >
          {t("permissions.loadMore")}
        </Button>
      )}
    </section>
  );
}
