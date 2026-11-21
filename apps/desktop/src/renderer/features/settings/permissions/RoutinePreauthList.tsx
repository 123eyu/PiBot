import { type Peer, useRpc, useRpcEvent, useT, waitRpc } from "@pibot/renderer-kit";
import {
  invalidReasonKey,
  operationText,
  usePages,
  useRoutineAction,
  useRoutineNavigation,
  useRoutineRefresh,
} from "@pibot/routines/ui";
import { Button } from "@pibot/ui";
import { useCallback, useId, useState } from "react";
import { FoldHeading } from "../FoldHeading.tsx";
import styles from "./permissions.module.css";

/** One Bot's scheduled-task preauthorizations, shown in that Bot's profile panel only. */
export function RoutinePreauthList({ botId }: { botId: string }) {
  const { peer } = useRpc(),
    t = useT(),
    { openRoutines } = useRoutineNavigation();
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
          if (routine.id !== p.routineId || (botId && routine.botId !== botId))
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
  const list = usePages(load),
    action = useRoutineAction();
  useRoutineRefresh(list.refresh, botId);
  useRpcEvent("permissions.changed", () => list.refresh());
  const [open, setOpen] = useState(true);
  const contentId = useId();
  return (
    <section>
      <FoldHeading
        title={t("routines.preauthGroup")}
        count={
          list.loading && !list.rows.length
            ? undefined
            : `${list.rows.length}${list.more ? "+" : ""}`
        }
        open={open}
        toggle={() => setOpen((value) => !value)}
        controls={contentId}
      />
      <div id={contentId} hidden={!open} className={styles.foldBody}>
        <p className={styles.note}>{t("routines.preauthGroupNote")}</p>
        <div className={styles.panel}>
          {list.rows.map((p) => (
            <div key={p.id} className={styles.row}>
              <div>
                <strong>
                  {p.name} · {t(`permissions.category.${p.operation.category}`)}
                </strong>
                <small>{operationText(p.operation, t)}</small>
                {p.invalidReason && <small>{t(invalidReasonKey(p.invalidReason))}</small>}
                <Button variant="ghost" onClick={() => openRoutines(p.routineId)}>
                  {t("routines.reviewTask")}
                </Button>
              </div>
              <Button
                variant="ghost"
                className={styles.danger}
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
        {list.loading && <p role="status">{t("common.loading")}</p>}
        {!list.loading && !list.error && !list.rows.length && <p>{t("routines.noPreauth")}</p>}
        {(list.error || action.error) && (
          <p role="alert" className={styles.danger}>
            {t(action.error ?? list.error ?? "routines.failed")}{" "}
            <Button disabled={action.busy} onClick={list.refresh}>
              {t("common.retry")}
            </Button>
          </p>
        )}
        {list.more && (
          <Button disabled={list.loading} onClick={() => void list.next()}>
            {t("permissions.loadMore")}
          </Button>
        )}
      </div>
    </section>
  );
}
