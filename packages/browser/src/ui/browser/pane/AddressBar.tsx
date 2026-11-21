import { useT } from "@pibot/renderer-kit";
import { type ReactNode, useEffect, useRef, useState } from "react";
import styles from "./bot-browser.module.css";
import { BrowserIcon } from "./icons.tsx";

/**
 * The address with back and reload. Editable whenever a page is shown (not only
 * during takeover); read-only while the pages sleep. `focusRequest` changing focuses the field.
 */
export function AddressBar({
  url: address,
  editable,
  focusRequest = 0,
  onNavigate,
  actions,
}: {
  actions?: ReactNode;
  url: string;
  editable: boolean;
  focusRequest?: number;
  onNavigate(action: "url" | "back" | "reload", url?: string): void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // A blank tab has nothing worth showing; the placeholder invites typing instead.
  const url = address === "about:blank" ? "" : address;
  useEffect(() => {
    if (focusRequest) input.current?.focus();
  }, [focusRequest]);
  if (!editable)
    return (
      <div className={styles.address}>
        <div className={styles.url} role="status" aria-label={t("botBrowser.address")} title={url}>
          {url.startsWith("https:") && <BrowserIcon name="lock" size={13} />}
          <span>{url}</span>
        </div>
        {actions}
      </div>
    );
  return (
    <div className={styles.address}>
      <button
        type="button"
        className={styles.navButton}
        aria-label={t("botBrowser.back")}
        title={t("botBrowser.back")}
        onClick={() => onNavigate("back")}
      >
        <BrowserIcon name="back" />
      </button>
      <input
        ref={input}
        className={`${styles.url} ${styles.urlEdit}`}
        aria-label={t("botBrowser.address")}
        placeholder={t("botBrowser.addressEdit")}
        value={draft ?? url}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => setDraft(null)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setDraft(null);
          if (event.key !== "Enter" || event.nativeEvent.isComposing || !draft?.trim()) return;
          const next = draft.trim().slice(0, 2048);
          setDraft(null);
          onNavigate("url", next);
        }}
      />
      {actions}
    </div>
  );
}
