import type { BrowserPage, Credential, LoginFillResult } from "@pibot/browser-contract/full";
import { createTranslator } from "@pibot/i18n";
import { Button, Icon, IconTile, ThemeProvider } from "@pibot/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./takeover-toolbar.module.css";

type State = {
  botId: string;
  botName: string;
  page: BrowserPage | null;
  documentId: string | null;
  accounts: Credential[];
  language: "zh" | "en";
  theme: "light" | "dark";
};
declare global {
  interface Window {
    pibotTakeover: {
      getState(): Promise<State>;
      fill(input: {
        credentialId: string;
        tab: string;
        documentId: string;
      }): Promise<LoginFillResult>;
      handBack(): Promise<{ ok: true }>;
      onChanged(callback: () => void): () => void;
    };
  }
}

/** This trusted toolbar runs in its own renderer, separate from website content. */
export function TakeoverToolbar() {
  const [state, setState] = useState<State>();
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<"filled" | "failed">();
  const owner = useRef(true);
  const locked = useRef(false);
  const generation = useRef(0);
  const shownDocument = useRef<string | null>(null);
  const load = useCallback(async () => {
    const version = ++generation.current;
    try {
      const next = await window.pibotTakeover.getState();
      if (!owner.current || version !== generation.current) return;
      setState(next);
      const sameDocument = shownDocument.current === next.documentId;
      shownDocument.current = next.documentId;
      setSelected((value) =>
        sameDocument && next.accounts.some((account) => account.id === value)
          ? value
          : next.accounts.length === 1
            ? (next.accounts[0]?.id ?? "")
            : "",
      );
    } catch {
      if (owner.current) setResult("failed");
    }
  }, []);
  useEffect(() => {
    owner.current = true;
    void load();
    const off = window.pibotTakeover.onChanged(() => {
      setResult(undefined);
      void load();
    });
    return () => {
      owner.current = false;
      generation.current++;
      off();
    };
  }, [load]);
  const t = createTranslator(state?.language ?? "en");
  const run = async (action: "fill" | "return") => {
    if (!state || locked.current) return;
    locked.current = true;
    setBusy(true);
    setResult(undefined);
    try {
      if (action === "return") await window.pibotTakeover.handBack();
      else {
        const current = await window.pibotTakeover.getState();
        if (
          !current.page ||
          !current.documentId ||
          current.documentId !== state.documentId ||
          !current.accounts.some((account) => account.id === selected)
        ) {
          setResult("failed");
          await load();
          return;
        }
        const outcome = await window.pibotTakeover.fill({
          credentialId: selected,
          tab: current.page.tab,
          documentId: current.documentId,
        });
        if (owner.current) setResult(outcome.ok ? "filled" : "failed");
      }
    } catch {
      if (owner.current) setResult("failed");
    } finally {
      locked.current = false;
      if (owner.current) setBusy(false);
    }
  };
  return (
    <ThemeProvider theme={state?.theme ?? "system"}>
      <main className={styles.toolbar} aria-label={t("credentials.takeoverFill")}>
        <IconTile icon="hand" tone="orange" />
        <span className={styles.youDrive}>
          <i aria-hidden="true" />
          {t("botBrowser.youDrive")}
        </span>
        <span className={styles.address} title={state?.page?.url}>
          <Icon name="link" size={13} />
          <span>{state?.page?.url ?? t("common.loading")}</span>
        </span>
        {result && (
          <span
            role={result === "filled" ? "status" : "alert"}
            className={styles.result}
            data-tone={result === "filled" ? "ok" : "danger"}
          >
            {t(`credentials.takeover.${result}`)}
          </span>
        )}
        {state && state.accounts.length > 1 && (
          <select
            aria-label={t("credentials.takeoverChoose")}
            value={selected}
            disabled={busy}
            onChange={(event) => setSelected(event.currentTarget.value)}
          >
            {!selected && <option value="">{t("credentials.takeoverChoose")}</option>}
            {state.accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.label}
                {account.hasTotp ? ` · ${t("credentials.totpEnabled")}` : ""}
              </option>
            ))}
          </select>
        )}
        <Button
          variant="secondary"
          disabled={busy || !selected || !state?.accounts.length || !state.documentId}
          loading={busy}
          title={!state?.accounts.length ? t("credentials.takeoverEmpty") : undefined}
          onClick={() => void run("fill")}
        >
          <Icon name="user" size={14} />
          {t("credentials.takeoverFill")}
        </Button>
        <Button
          className={styles.handBack}
          disabled={busy || !state}
          onClick={() => void run("return")}
        >
          {t("botBrowser.handBack", { name: state?.botName ?? "" })}
        </Button>
      </main>
    </ThemeProvider>
  );
}
