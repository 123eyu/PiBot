import type { BrowserDiagnostics } from "@pibot/browser-contract/full";
import { useT } from "@pibot/renderer-kit";
import { Chip, type ChipProps, IconTile, SegmentedControl } from "@pibot/ui";
import { useState } from "react";
import styles from "../pane/bot-browser.module.css";

type Entry = BrowserDiagnostics["entries"][number];
type NetworkEntry = NonNullable<BrowserDiagnostics["network"]>["entries"][number];

const levelTone = (entry: Entry): ChipProps["tone"] =>
  entry.level === "error" ? "danger" : "warn";
const statusTone = (status: number): ChipProps["tone"] =>
  status >= 500 || status === 0
    ? "danger"
    : status >= 400
      ? "warn"
      : status >= 300
        ? "neutral"
        : "ok";

/**
 * 页面问题 and 网络记录 as one segmented card. Facts remain plain
 * text; console output must never become renderer HTML.
 */
export function BrowserDebugMessages({
  busy,
  error,
  data,
}: {
  busy: boolean;
  error: boolean;
  data?: BrowserDiagnostics;
}) {
  const t = useT();
  const [view, setView] = useState<"issues" | "network">("issues");
  const network = data?.network;
  const shown = network ? view : "issues";
  return (
    <>
      {busy && (
        <div className={styles.debugState} role="status">
          <IconTile icon="refresh" tone="blue" size="sm" />
          <span>{t("browserDebug.loading")}</span>
        </div>
      )}
      {error && (
        <div className={styles.debugState} role="alert">
          <IconTile icon="warning" tone="red" size="sm" />
          <span>{t("browserDebug.failed")}</span>
        </div>
      )}
      {data && !data.supported && (
        <div className={styles.debugState}>
          <IconTile icon="info" tone="neutral" size="sm" />
          <span>{t("browserDebug.unsupported")}</span>
        </div>
      )}
      {network && (
        <SegmentedControl<"issues" | "network">
          label={t("browserDebug.title")}
          className={styles.debugTabs}
          value={shown}
          options={[
            {
              value: "issues",
              label: data.entries.length
                ? `${t("browserDebug.tabIssues")} · ${data.entries.length}`
                : t("browserDebug.tabIssues"),
            },
            { value: "network", label: t("browserDebug.tabNetwork") },
          ]}
          onValueChange={setView}
        />
      )}
      {shown === "issues" && (
        <>
          {data?.dropped && <small className={styles.debugNote}>{t("browserDebug.dropped")}</small>}
          {data?.supported && !data.entries.length && (
            <div className={styles.debugState}>
              <IconTile icon="check" tone="green" size="sm" />
              <span>{t("browserDebug.empty")}</span>
            </div>
          )}
          {!!data?.entries.length && (
            <ul className={styles.debugList}>
              {data.entries.map((entry) => (
                <li key={entry.seq} className={styles.debugRow}>
                  <span className={styles.debugRowHead}>
                    <Chip tone={levelTone(entry)}>
                      {t(`browserDebug.${entry.kind}`)}
                      {entry.status ? ` ${entry.status}` : ""}
                    </Chip>
                  </span>
                  <span className={styles.debugText}>{entry.text}</span>
                  {entry.url && (
                    <span className={styles.debugUrl} title={entry.url}>
                      {entry.url}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {shown === "network" && network && (
        <>
          <small className={styles.debugNote}>{t("browserDebug.networkLog")}</small>
          {network.dropped && (
            <small className={styles.debugNote}>{t("browserDebug.dropped")}</small>
          )}
          {!network.entries.length && (
            <div className={styles.debugState}>
              <IconTile icon="network" tone="neutral" size="sm" />
              <span>{t("browserDebug.networkEmpty")}</span>
            </div>
          )}
          {!!network.entries.length && (
            <ul className={styles.debugList}>
              {network.entries.map((entry) => (
                <NetworkRow key={entry.seq} entry={entry} />
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}

function NetworkRow({ entry }: { entry: NetworkEntry }) {
  return (
    <li className={styles.debugRow}>
      <details className={styles.debugDetails}>
        <summary title={entry.url}>
          <Chip tone={statusTone(entry.status)}>{entry.status}</Chip>
          <span className={styles.debugMethod}>{entry.method}</span>
          <span className={styles.debugUrl}>{entry.url}</span>
        </summary>
        <pre className={styles.debugCode}>{JSON.stringify(entry, null, 2)}</pre>
      </details>
    </li>
  );
}
