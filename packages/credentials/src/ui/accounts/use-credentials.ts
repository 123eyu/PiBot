import type { Credential, CredentialStatus, MethodResults } from "@pibot/credentials-contract/full";
import { RpcError, RpcErrorCodes } from "@pibot/credentials-contract/full";
import { useRpc, useRpcEvent } from "@pibot/renderer-kit";
import { useCallback, useEffect, useRef, useState } from "react";

type Bot = MethodResults["bots.list"][number];
const PAGE = 100;

/** Chat Bots that can own a browser (image Bots never browse); refreshed on bots.changed. */
export function useBrowserBots() {
  const { peer } = useRpc();
  const [bots, setBots] = useState<Bot[]>([]);
  const load = useCallback(async () => {
    if (!peer) return;
    const list = await peer.call("bots.list", { limit: 200 });
    setBots(list.filter((bot) => !bot.archivedAt && bot.category !== "image"));
  }, [peer]);
  useEffect(() => {
    void load().catch(() => setBots([]));
  }, [load]);
  useRpcEvent("bots.changed", () => void load().catch(() => {}));
  return bots;
}

export function useCredentialStatus() {
  const { peer } = useRpc();
  const [status, setStatus] = useState<CredentialStatus>();
  const load = useCallback(async () => {
    if (!peer) return;
    setStatus(await peer.call("credentials.status", undefined));
  }, [peer]);
  useEffect(() => {
    void load().catch(() => setStatus({ storage: false, reveal: false }));
  }, [load]);
  return status;
}

/**
 * Saved accounts, paged by `after` (site, display name order). A change event reloads the pages
 * already shown; at most one load runs at a time and a newer one supersedes an older result.
 */
export function useCredentialList(botId?: string) {
  const { peer } = useRpc();
  const [items, setItems] = useState<Credential[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const version = useRef(0);
  const shown = useRef(PAGE);
  const load = useCallback(
    async (more = false) => {
      if (!peer) return;
      const mine = ++version.current;
      setLoading(true);
      setError(false);
      try {
        const after = more ? items.at(-1)?.id : undefined;
        const limit = more ? PAGE : Math.min(Math.max(shown.current, PAGE), 200);
        const page = await peer.call("credentials.list", {
          limit,
          ...(botId ? { botId } : {}),
          ...(after ? { after } : {}),
        });
        if (mine !== version.current) return;
        const next = more ? [...items, ...page] : page;
        shown.current = next.length;
        setItems(next);
        setHasMore(page.length === limit);
      } catch {
        if (mine === version.current) setError(true);
      } finally {
        if (mine === version.current) setLoading(false);
      }
    },
    [peer, botId, items],
  );
  const loadRef = useRef(load);
  loadRef.current = load;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reload only when the peer or Bot changes.
  useEffect(() => {
    void loadRef.current();
  }, [peer, botId]);
  useRpcEvent("credentials.changed", () => void loadRef.current());
  return { items, hasMore, loading, error, load };
}

export function errorKey(error: unknown) {
  if (error instanceof RpcError) {
    if (error.code === RpcErrorCodes.secretsUnavailable) return "credentials.error.storage";
    if (error.message === "credential_totp_invalid") return "credentials.error.totp";
    if (error.message === "credential_site_invalid") return "credentials.error.site";
    if (error.message === "credential_secret_required") return "credentials.error.secret";
  }
  return "credentials.error.generic";
}
