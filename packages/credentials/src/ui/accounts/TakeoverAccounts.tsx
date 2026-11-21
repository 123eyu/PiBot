import type { MethodResults } from "@pibot/credentials-contract/full";
import { type Peer, useT } from "@pibot/renderer-kit";
import { Button, Icon, IconTile } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import styles from "./credentials.module.css";

type Accounts = NonNullable<MethodResults["credentials.takeoverAccounts"]>;
export function TakeoverAccounts({
  botId,
  groupId,
  peer,
  pageKey,
}: {
  botId: string;
  groupId?: string;
  peer: Peer;
  pageKey: string;
}) {
  const t = useT();
  const [accounts, setAccounts] = useState<Accounts>();
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<"filled" | "failed" | "empty">();
  const owner = useRef(new AbortController());
  const locked = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Navigation retires the account/document snapshot.
  useEffect(() => {
    const lifetime = new AbortController();
    owner.current = lifetime;
    setAccounts(undefined);
    setChoosing(false);
    setResult(undefined);
    setBusy(false);
    locked.current = false;
    void peer
      .call(
        "credentials.takeoverAccounts",
        { botId, ...(groupId ? { groupId } : {}) },
        { signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)]) },
      )
      .then((value) => {
        if (!lifetime.signal.aborted) setAccounts(value ?? undefined);
      })
      .catch(() => {
        if (!lifetime.signal.aborted) setResult("failed");
      });
    return () => lifetime.abort();
  }, [botId, groupId, peer, pageKey]);
  const fill = async (snapshot: Accounts, credentialId: string) => {
    const outcome = await peer.call(
      "credentials.fillForTakeover",
      {
        botId,
        ...(groupId ? { groupId } : {}),
        credentialId,
        tab: snapshot.page.tab,
        documentId: snapshot.documentId,
      },
      { signal: AbortSignal.any([owner.current.signal, AbortSignal.timeout(30_000)]) },
    );
    if (!owner.current.signal.aborted) setResult(outcome.ok ? "filled" : "failed");
  };
  const run = async (credentialId?: string) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setResult(undefined);
    const lifetime = owner.current;
    try {
      // Re-read the document identity immediately before filling; menu metadata
      // must not silently select a different account after navigation.
      const snapshot = await peer.call(
        "credentials.takeoverAccounts",
        { botId, ...(groupId ? { groupId } : {}) },
        { signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)]) },
      );
      if (lifetime.signal.aborted) return;
      setAccounts(snapshot ?? undefined);
      if (!snapshot?.accounts.length) {
        setResult("empty");
        return;
      }
      if (credentialId) {
        if (!snapshot.accounts.some((account) => account.id === credentialId)) {
          setResult("failed");
          return;
        }
        await fill(snapshot, credentialId);
        setChoosing(false);
      } else if (snapshot.accounts.length === 1 && snapshot.accounts[0])
        await fill(snapshot, snapshot.accounts[0].id);
      else setChoosing(true);
    } catch {
      if (!lifetime.signal.aborted) setResult("failed");
    } finally {
      if (!lifetime.signal.aborted) {
        locked.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <div className={styles.takeoverAccounts}>
      <Button
        variant="secondary"
        loading={busy}
        disabled={busy || !accounts?.accounts.length}
        title={!accounts?.accounts.length ? t("credentials.takeoverEmpty") : undefined}
        onClick={() => void run()}
      >
        <Icon name="user" size={14} />
        {t("credentials.takeoverFill")}
      </Button>
      {choosing && (
        <fieldset className={styles.accountMenu} aria-label={t("credentials.takeoverChoose")}>
          {accounts?.accounts.map((account) => (
            <Button
              key={account.id}
              variant="ghost"
              disabled={busy}
              onClick={() => void run(account.id)}
            >
              <IconTile icon="user" tone="blue" size="sm" className={styles.chatTile} />
              {account.label}
              {account.hasTotp ? ` · ${t("credentials.totpEnabled")}` : ""}
            </Button>
          ))}
          <Button variant="ghost" disabled={busy} onClick={() => setChoosing(false)}>
            <IconTile icon="close" tone="neutral" size="sm" />
            {t("common.cancel")}
          </Button>
        </fieldset>
      )}
      {result && (
        <span className={styles.hint} role={result === "filled" ? "status" : "alert"}>
          {t(`credentials.takeover.${result}`)}
        </span>
      )}
    </div>
  );
}
