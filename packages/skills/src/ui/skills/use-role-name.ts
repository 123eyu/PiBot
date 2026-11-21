import { useRpc, useSettings } from "@pibot/renderer-kit";
import { useEffect, useState } from "react";

export function useRoleName(botId: string) {
  const { peer } = useRpc(),
    { language } = useSettings();
  const [value, setValue] = useState<{ key: string; name?: string }>();
  const key = `${botId}:${language}`;
  useEffect(() => {
    if (!peer) return;
    const abort = new AbortController();
    void Promise.all([
      peer.call("bots.profile", { botId }, { signal: abort.signal, timeoutMs: 10000 }),
      peer.call("builtin.catalog", undefined, { signal: abort.signal, timeoutMs: 10000 }),
    ]).then(
      ([profile, catalog]) => {
        if (!abort.signal.aborted)
          setValue({
            key,
            name: catalog.roles.find((role) => role.id === profile.bot.role?.id)?.name,
          });
      },
      () => {
        if (!abort.signal.aborted) setValue({ key });
      },
    );
    return () => abort.abort();
  }, [peer, botId, key]);
  return value?.key === key ? value.name : undefined;
}
