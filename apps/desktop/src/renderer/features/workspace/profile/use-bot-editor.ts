import { type Bot, type MethodParams, RpcError, RpcErrorCodes } from "@pibot/protocol";
import { useRpc } from "@pibot/renderer-kit";
import { useCallback, useEffect, useRef, useState } from "react";
import { updateBot } from "../../settings/operations.ts";
import { checkedProfile } from "./profile.ts";

export type BotUpdate = Omit<MethodParams["bots.update"], "botId">;
export function useBotEditor(botId: string) {
  const { peer } = useRpc();
  const [bot, setBot] = useState<Bot>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const epoch = useRef(0);
  const reads = useRef(0);
  const locked = useRef(false);
  const refresh = useCallback(async () => {
    if (!peer) return;
    const version = epoch.current;
    const request = ++reads.current;
    setLoading(true);
    try {
      const profile = checkedProfile(await peer.call("bots.profile", { botId }), botId);
      if (version === epoch.current && request === reads.current) {
        setBot(profile.bot);
        setError(false);
      }
    } catch {
      if (version === epoch.current && request === reads.current) setError(true);
    } finally {
      if (version === epoch.current && request === reads.current) setLoading(false);
    }
  }, [peer, botId]);
  useEffect(() => {
    epoch.current++;
    setBot(undefined);
    setError(false);
    setBusy(false);
    locked.current = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = peer?.on("bots.changed", (event) => {
      if (event.botId !== botId) return;
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 250);
    });
    void refresh();
    return () => {
      epoch.current++;
      clearTimeout(timer);
      off?.();
    };
  }, [peer, botId, refresh]);
  /** `name_taken` is answered under the name field, not as the panel's general failure. */
  const apply = useCallback(
    async (patch: BotUpdate): Promise<boolean | "name_taken"> => {
      if (!peer || locked.current) return false;
      locked.current = true;
      const version = epoch.current;
      reads.current++;
      setBusy(true);
      setError(false);
      try {
        const updated = await updateBot(peer, { botId, ...patch });
        if (updated.id !== botId) throw new Error("Bot target mismatch");
        if (version !== epoch.current) return false;
        reads.current++;
        setBot(updated);
        setLoading(false);
        return true;
      } catch (failure) {
        if (failure instanceof RpcError && failure.code === RpcErrorCodes.botNameTaken)
          return "name_taken";
        if (version === epoch.current) setError(true);
        return false;
      } finally {
        if (version === epoch.current) {
          locked.current = false;
          setBusy(false);
        }
      }
    },
    [peer, botId],
  );
  const save = useCallback(async (patch: BotUpdate) => (await apply(patch)) === true, [apply]);
  const rename = useCallback((name: string) => apply({ name }), [apply]);
  return { bot, loading, busy, error, save, rename, refresh };
}
