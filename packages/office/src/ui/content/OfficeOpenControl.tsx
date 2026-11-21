import type { OfficeApps, PreviewSource } from "@pibot/office-contract/full";
import { useRpc, useT } from "@pibot/renderer-kit";
import { Button, Combobox, Icon, IconTile } from "@pibot/ui";
import { useEffect, useState } from "react";
import { officeFormat } from "./format.ts";
import styles from "./office.module.css";

/** The named app is explicitly selected; it is not a claim about the OS default association. */
export function OfficeOpenControl({
  name,
  source,
  selectedApp,
  onSelectApp,
}: {
  name: string;
  /** A message attachment or a file a run changed; the brain resolves the real path. */
  source: PreviewSource;
  selectedApp?: string;
  onSelectApp?(id: string): void;
}) {
  const t = useT();
  const { peer } = useRpc();
  const [apps, setApps] = useState<OfficeApps>();
  const [selected, setSelected] = useState<string | undefined>(selectedApp);
  const [openFailed, setOpenFailed] = useState(false);
  const [opening, setOpening] = useState(false);
  const format = officeFormat(name);
  useEffect(() => {
    if (!peer || !format) return;
    const abort = new AbortController();
    setApps(undefined);
    void peer
      .call("office.apps", { format }, { signal: abort.signal, timeoutMs: 30_000 })
      .then((value) => {
        if (!abort.signal.aborted) {
          setApps(value);
          setSelected((previous) =>
            previous === "system" || value.apps.some((app) => app.id === previous)
              ? previous
              : (value.apps[0]?.id ?? "system"),
          );
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) {
          // Discovery failure does not mean the OS default handler is unavailable.
          setApps({ apps: [], defaultAvailable: true });
          setSelected("system");
        }
      });
    return () => abort.abort();
  }, [peer, format]);
  const chosen = apps?.apps.find((app) => app.id === selected);
  const label = chosen?.name ?? t(!apps ? "common.loading" : "office.systemApp");
  const canOpen = !!chosen || !!apps?.defaultAvailable;
  return (
    <div className={styles.openArea}>
      <div className={styles.openControl}>
        <Button
          variant="ghost"
          disabled={!peer || opening || !canOpen}
          title={t("office.openIn", { app: label })}
          onClick={() => {
            if (!peer) return;
            setOpening(true);
            setOpenFailed(false);
            void peer
              .call(
                "office.open",
                { ...source, ...(chosen ? { appId: chosen.id } : {}) },
                { timeoutMs: 30_000 },
              )
              .catch(() => setOpenFailed(true))
              .finally(() => setOpening(false));
          }}
        >
          <Icon name="arrow" size={15} />
          {t("office.open")}
        </Button>
        <Combobox
          variant="pill"
          hideLabel
          label={t("office.openWith")}
          value={selected ?? "system"}
          options={[
            // Each choice leads with a tile, like every other menu item.
            ...(apps?.apps ?? []).map((app) => ({
              value: app.id,
              label: app.name,
              leading: <IconTile icon="box" tone="violet" size="sm" />,
            })),
            ...(apps?.defaultAvailable
              ? [
                  {
                    value: "system",
                    label: t("office.systemApp"),
                    leading: <IconTile icon="settings" tone="neutral" size="sm" />,
                  },
                ]
              : []),
          ]}
          onValueChange={(id) => {
            setSelected(id);
            onSelectApp?.(id);
          }}
          placeholder={label}
          searchPlaceholder={t("combobox.searchPlaceholder")}
          noResultsText={t("combobox.noResults")}
          moreResultsText={(count) => t("combobox.moreResults", { count })}
          disabled={!peer || !apps || opening}
        />
      </div>
      {openFailed && (
        <span className={styles.error} role="alert">
          {t("attachments.openFailed")}
        </span>
      )}
    </div>
  );
}
