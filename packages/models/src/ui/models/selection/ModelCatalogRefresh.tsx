import { setupStyles as styles, TaskStatus, useRpc, useT, useTask } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useRef } from "react";
import { requirePeer, SetupError } from "../../setup/operations.ts";

export function ModelCatalogRefresh() {
  const t = useT(),
    { peer } = useRpc(),
    task = useTask();
  const lifetime = useRef(new AbortController());
  useEffect(() => {
    lifetime.current = new AbortController();
    return () => lifetime.current.abort();
  }, []);
  return (
    <section className={styles.stack} aria-label={t("models.refreshCatalog")}>
      <Button
        variant="secondary"
        disabled={task.busy || !peer}
        loading={task.busy}
        onClick={() =>
          void task.run(async () => {
            try {
              const result = await requirePeer(peer).call(
                "models.refresh",
                { providerId: "openrouter" },
                {
                  signal: AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(30_000)]),
                  timeoutMs: 30_000,
                },
              );
              task.setSuccess(t("models.catalogRefreshed", { count: result.count }));
            } catch {
              throw new SetupError("models.catalogRefreshFailed");
            }
          })
        }
      >
        {t("models.refreshCatalog")}
      </Button>
      <p className={styles.note}>{t("models.catalogRefreshHelp")}</p>
      <TaskStatus task={task} />
    </section>
  );
}
