import type { Bot } from "@pibot/protocol";
import { useRpc } from "@pibot/renderer-kit";
import { useCallback, useEffect, useRef, useState } from "react";
import { auditRead } from "./rpc.ts";

export function useAuditBots() {
  const { peer } = useRpc();
  const [state, setState] = useState({
    bots: [] as Bot[],
    loading: true,
    error: false,
    more: false,
  });
  const current = useRef<
    | {
        lifetime: AbortController;
        bots: Bot[];
        before?: string;
        cursors: Set<string>;
        locked: boolean;
      }
    | undefined
  >(undefined);
  const load = useCallback(async () => {
    const request = current.current;
    if (!peer || !request || request.locked) return;
    request.locked = true;
    setState((state) => ({ ...state, loading: true, error: false }));
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 30_000);
    try {
      const page = await auditRead(
        () =>
          peer.call("bots.list", {
            limit: 200,
            includeArchived: true,
            ...(request.before ? { before: request.before } : {}),
          }),
        AbortSignal.any([request.lifetime.signal, deadline.signal]),
      );
      if (request !== current.current || request.lifetime.signal.aborted) return;
      const before = page.at(-1)?.id;
      if (before && request.cursors.has(before)) throw new Error("Bot cursor repeated");
      if (before) request.cursors.add(before);
      const ids = new Set(request.bots.map((bot) => bot.id));
      request.bots.push(...page.filter((bot) => !ids.has(bot.id)));
      request.before = before;
      setState({
        bots: [...request.bots],
        loading: false,
        error: false,
        more: page.length === 200,
      });
    } catch {
      if (request === current.current && !request.lifetime.signal.aborted)
        setState((state) => ({ ...state, loading: false, error: true }));
    } finally {
      clearTimeout(timer);
      request.locked = false;
    }
  }, [peer]);
  useEffect(() => {
    const request = {
      lifetime: new AbortController(),
      bots: [] as Bot[],
      cursors: new Set<string>(),
      locked: false,
    };
    current.current = request;
    setState({ bots: [], loading: !!peer, error: !peer, more: false });
    void load();
    return () => {
      request.lifetime.abort();
      if (current.current === request) current.current = undefined;
    };
  }, [load, peer]);
  return { ...state, load };
}
