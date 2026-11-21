import { useRpc, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useState } from "react";
import styles from "../settings/remote.module.css";

const PAGE_SIZE = 50;

export function EndpointScope({
  kind,
  value,
  disabled,
  change,
}: {
  kind: "bots" | "groups";
  value: string[] | null;
  disabled: boolean;
  change(value: string[] | null): void;
}) {
  const t = useT();
  const { peer } = useRpc();
  const [page, setPage] = useState<{ id: string; name: string }[]>();
  const [cursors, setCursors] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const [failed, setFailed] = useState(false);
  const restricted = value !== null;
  const cursor = cursors.at(-1);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly retries the same page
  useEffect(() => {
    if (!peer || !restricted) return;
    const controller = new AbortController();
    setPage(undefined);
    setFailed(false);
    void peer
      .call(
        kind === "bots" ? "bots.list" : "groups.list",
        { before: cursor, limit: PAGE_SIZE },
        {
          signal: controller.signal,
          timeoutMs: 10_000,
        },
      )
      .then(
        (items) => {
          if (!controller.signal.aborted) setPage(items);
        },
        () => {
          if (!controller.signal.aborted) setFailed(true);
        },
      );
    return () => controller.abort();
  }, [peer, kind, restricted, cursor, revision]);

  const visible = new Set(page?.map(({ id }) => id));
  const elsewhere = value?.filter((id) => !visible.has(id)) ?? [];
  return (
    <fieldset className={styles.scope} disabled={disabled}>
      <legend>{t(`remote.cap.scope.${kind}`)}</legend>
      <label className={styles.choice}>
        <input
          type="checkbox"
          checked={!restricted}
          onChange={(event) => {
            setCursors([]);
            change(event.target.checked ? null : []);
          }}
        />
        {t("remote.cap.scope.all")}
      </label>
      {value !== null &&
        (failed ? (
          <div role="alert">
            {t("remote.cap.loadFailed")}{" "}
            <Button variant="secondary" onClick={() => setRevision((n) => n + 1)}>
              {t("remote.retry")}
            </Button>
          </div>
        ) : !page ? (
          <div role="status">{t("remote.loading")}</div>
        ) : (
          <>
            {!page.length && <span>{t("remote.cap.scope.empty")}</span>}
            {page.map(({ id, name }) => {
              const checked = value.includes(id);
              return (
                <label className={styles.choice} key={id}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!checked && value.length >= 1000}
                    onChange={() =>
                      change(checked ? value.filter((item) => item !== id) : [...value, id])
                    }
                  />
                  {name}
                </label>
              );
            })}
            {elsewhere.length > 0 && (
              <div className={styles.actions}>
                {t("remote.cap.scope.elsewhere", { count: elsewhere.length })}
                <Button
                  variant="ghost"
                  onClick={() => change(value.filter((id) => visible.has(id)))}
                >
                  {t("remote.cap.scope.clearElsewhere")}
                </Button>
              </div>
            )}
            <div className={styles.actions}>
              {cursors.length > 0 && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setPage(undefined);
                    setCursors((old) => old.slice(0, -1));
                  }}
                >
                  {t("remote.cap.previous")}
                </Button>
              )}
              {page.length === PAGE_SIZE && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    const last = page.at(-1)?.id;
                    if (last) {
                      setPage(undefined);
                      setCursors((old) => [...old, last]);
                    }
                  }}
                >
                  {t("remote.more")}
                </Button>
              )}
            </div>
          </>
        ))}
    </fieldset>
  );
}
