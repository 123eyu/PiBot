/**
 * A run fell back to the Bot browser because the user's browser has no Pi Bot extension.
 * The card opens the extension's store page in that browser and turns into "connected" once the
 * extension says hello; installing is the user's one click in the store, never done for them.
 */
import type { BrowserExtensionStatusSchema, ChatNotice } from "@pibot/protocol";
import { useRpc, useRpcEvent, useT } from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import type { z } from "zod";
import styles from "../chat.module.css";
import lively from "../tools/lively.module.css";

type Status = z.infer<typeof BrowserExtensionStatusSchema>;
type BrowserId = NonNullable<Status["defaultBrowser"]>["id"];

const CHROME_STORE = "https://chromewebstore.google.com/detail/jfaelafpdicbnlnbngicngehehafpmbk";
const FIREFOX_STORE = "https://addons.mozilla.org/firefox/addon/pibot-browser/";
// Edge, Brave and Chromium install Chrome Web Store items; only Firefox has its own listing.
const STORES: Partial<Record<BrowserId, string>> = {
  chrome: CHROME_STORE,
  edge: CHROME_STORE,
  brave: CHROME_STORE,
  chromium: CHROME_STORE,
  firefox: FIREFOX_STORE,
};
const WAIT_MS = 3 * 60_000;
const dismissedKey = "pibot.browser-extension.install.dismissed";

export function BrowserExtensionInstallCard({
  notice,
}: {
  notice: Extract<ChatNotice, { kind: "browser_extension" }>;
}) {
  const t = useT();
  const { peer } = useRpc();
  const [status, setStatus] = useState<Status>();
  const [phase, setPhase] = useState<"ready" | "waiting" | "success" | "failed" | "closed">(
    "ready",
  );
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(dismissedKey) === "1";
    } catch {
      // Storage blocked: the card simply shows again.
      return false;
    }
  });

  useEffect(() => {
    if (!peer) return;
    let active = true;
    void peer
      .call("browserExtension.status", {})
      .then((value) => {
        if (active) setStatus(value);
      })
      // Without a status the card stays hidden; the changed event fills it in later.
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [peer]);
  useRpcEvent("browserExtension.changed", (value) => {
    setStatus(value);
    if (value.extension === "connected")
      setPhase((current) => (current === "waiting" || current === "failed" ? "success" : current));
  });
  useEffect(() => () => clearTimeout(timer.current), []);

  if (!status || dismissed || phase === "closed") return null;
  const id = status.defaultBrowser?.id;
  const store = id ? STORES[id] : undefined;
  // Installed but not connected right now (browser closed, extension switched off): the old line.
  if (phase === "ready" && status.extension === "installed")
    return (
      <p className={styles.systemLine} role="note">
        {t("botBrowser.notice.extensionFallback")}
      </p>
    );
  // Already connected before this card was seen, or a browser the extension does not support.
  if (phase === "ready" && (status.extension === "connected" || !store)) return null;
  const browser = status.defaultBrowser?.name ?? "";

  const install = () => {
    if (!store) return;
    // The main process hands https links to the system browser, which is this default browser.
    window.open(store, "_blank", "noopener,noreferrer");
    setPhase("waiting");
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => setPhase((current) => (current === "waiting" ? "failed" : current)),
      WAIT_MS,
    );
  };
  const neverAsk = () => {
    try {
      localStorage.setItem(dismissedKey, "1");
    } catch {
      // Storage blocked: only this convenience is lost; the card closes for now.
    }
    setDismissed(true);
  };
  const title =
    phase === "success"
      ? t("browserExtension.install.success", { browser })
      : phase === "failed"
        ? t("browserExtension.install.failed")
        : t("browserExtension.install.title", { browser });

  return (
    <section
      className={`${lively.card} ${lively.extensionInstall}`}
      aria-label={title}
      data-notice-id={notice.id}
    >
      <header>
        <Icon name="globe" size={16} />
        <span>{title}</span>
      </header>
      <div className={lively.extensionBody}>
        {phase === "ready" && (
          <>
            <p>{t("browserExtension.install.description")}</p>
            <ol>
              <li>{t("browserExtension.install.step.open", { browser })}</li>
              {id === "edge" && <li>{t("browserExtension.install.step.edge")}</li>}
              <li>
                {t(
                  id === "firefox"
                    ? "browserExtension.install.step.addFirefox"
                    : "browserExtension.install.step.add",
                )}
              </li>
              <li>{t("browserExtension.install.step.connect")}</li>
            </ol>
          </>
        )}
        {phase === "waiting" && <p>{t("browserExtension.install.waiting", { browser })}</p>}
        {phase === "success" && <p>{t("browserExtension.install.successNote")}</p>}
        {phase === "failed" && <p>{t("browserExtension.install.failedNote")}</p>}
      </div>
      <footer>
        {(phase === "ready" || phase === "failed") && (
          <>
            <Button variant="primary" onClick={install}>
              {t(
                phase === "ready"
                  ? "browserExtension.install.open"
                  : "browserExtension.install.again",
              )}
            </Button>
            <Button variant="ghost" onClick={() => setPhase("closed")}>
              {t("browserExtension.install.useBot")}
            </Button>
          </>
        )}
        {phase === "waiting" && (
          <Button variant="ghost" onClick={install}>
            {t("browserExtension.install.again")}
          </Button>
        )}
        {phase !== "success" && (
          <Button variant="ghost" onClick={neverAsk}>
            {t("browserExtension.install.never")}
          </Button>
        )}
      </footer>
    </section>
  );
}
