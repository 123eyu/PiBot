import type { BrowserDiagnostics } from "@pibot/browser-contract/full";
import { type Peer, useT } from "@pibot/renderer-kit";
import { Button, IconTile } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import { useBrowserUiPorts } from "../../shell/ports.tsx";
import styles from "../pane/bot-browser.module.css";
import { BrowserDebugMessages } from "./BrowserDebugMessages.tsx";
import { publicBrowserAddress } from "./debug-feedback.ts";

/** Navigation invalidates diagnostics, not the user's open popover. Selection has its own lane. */
export function BrowserDiagnosticsMenu({
  botId,
  groupId,
  conversationId,
  peer,
  tabId,
  documentId,
  url,
  disabled,
  onFeedback,
}: {
  botId: string;
  groupId?: string;
  conversationId: string;
  peer: Peer;
  tabId?: string;
  documentId?: string;
  url: string;
  disabled: boolean;
  onFeedback?(conversationId: string, text: string): void;
}) {
  const { PopupMenu } = useBrowserUiPorts();
  const t = useT();
  const scope = JSON.stringify([botId, groupId, conversationId, tabId, documentId]);
  const [expanded, setExpanded] = useState(false);
  const [data, setData] = useState<{ peer: Peer; scope: string; value: BrowserDiagnostics }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [added, setAdded] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);
  const latest = useRef({ peer, scope, disabled, expanded });
  latest.current = { peer, scope, disabled, expanded };
  const read = async () => {
    request.current?.abort();
    if (disabled) return;
    const controller = new AbortController();
    request.current = controller;
    const current = () =>
      !controller.signal.aborted &&
      request.current === controller &&
      latest.current.peer === peer &&
      latest.current.scope === scope &&
      !latest.current.disabled;
    setBusy(true);
    setError(false);
    setAdded(false);
    try {
      const value = await peer.call(
        "browser.debug",
        { botId, ...(groupId ? { groupId } : {}), conversationId, tabId, limit: 50 },
        { signal: controller.signal, timeoutMs: 15000 },
      );
      if (!current()) return;
      if (documentId && value.documentId !== documentId) throw new Error("browser_selection_stale");
      setData({ peer, scope, value });
    } catch {
      if (current()) setError(true);
    } finally {
      if (current()) setBusy(false);
    }
  };
  const readRef = useRef(read);
  readRef.current = read;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reconnection and navigation invalidate buffered diagnostics and pending reads.
  useEffect(() => {
    request.current?.abort();
    setData(undefined);
    setBusy(false);
    setError(false);
    setAdded(false);
    if (latest.current.expanded && !disabled) void readRef.current();
    return () => request.current?.abort();
  }, [peer, scope, disabled]);
  useEffect(() => {
    if (!expanded || disabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = peer.on("browser.state", (event) => {
      if (event.botId !== botId || event.groupId !== groupId) return;
      clearTimeout(timer);
      timer = setTimeout(() => void readRef.current(), 250);
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [peer, botId, groupId, expanded, disabled]);
  const value = data?.scope === scope && data.peer === peer ? data.value : undefined;
  return (
    <PopupMenu
      label={`${t("browserDebug.title")}${value?.entries.length ? ` (${value.entries.length})` : ""}`}
      icon="audit"
      showLabel
      disabled={disabled}
      onOpenChange={(open) => {
        setExpanded(open);
        if (open && !disabled) void readRef.current();
        else {
          request.current?.abort();
          setBusy(false);
        }
      }}
    >
      <div className={styles.debugResults}>
        <span className={styles.debugHead}>
          <IconTile icon="audit" tone="blue" size="sm" />
          <strong>{t("browserDebug.title")}</strong>
        </span>
        <BrowserDebugMessages busy={busy} error={error} data={value} />
        {(error || !!value?.entries.length) && (
          <div className={styles.debugActions}>
            {error && (
              <Button
                variant="pill"
                disabled={busy || disabled}
                onClick={() => void readRef.current()}
              >
                {t("common.retry")}
              </Button>
            )}
            {!!value?.entries.length && (
              <Button
                variant="pill"
                className={styles.debugPrimary}
                disabled={disabled || busy || error || added || !onFeedback}
                onClick={() => {
                  if (
                    disabled ||
                    busy ||
                    error ||
                    added ||
                    !value ||
                    data?.peer !== latest.current.peer ||
                    data?.scope !== latest.current.scope
                  )
                    return;
                  onFeedback?.(
                    conversationId,
                    t("agentWork.debugFeedback", {
                      url: publicBrowserAddress(url),
                      issues: value.entries
                        .map(
                          (entry) =>
                            `${t(`browserDebug.${entry.kind}`)}${entry.status ? ` ${entry.status}` : ""}: ${entry.text}${entry.url ? ` — ${publicBrowserAddress(entry.url)}` : ""}`,
                        )
                        .join("\n"),
                    }),
                  );
                  setAdded(true);
                }}
              >
                {t(added ? "browserDebug.added" : "agentWork.debugAddAll")}
              </Button>
            )}
          </div>
        )}
      </div>
    </PopupMenu>
  );
}
