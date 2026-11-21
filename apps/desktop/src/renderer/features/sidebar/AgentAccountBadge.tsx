// Sidebar badges read cached account evidence; listing Bots never launches an agent.

import { useRpc, useRpcEvent, useT } from "@pibot/renderer-kit";
import { Chip } from "@pibot/ui";
import { useEffect, useState } from "react";

export function AgentAccountBadge({ botId }: { botId: string }) {
  const { peer } = useRpc();
  const t = useT();
  const [kind, setKind] = useState("unknown");
  useRpcEvent("externalAgents.statusChanged", (event) => {
    if (event.botId === botId) setKind(event.status.kind);
  });
  useEffect(() => {
    setKind("unknown");
    if (!peer) return;
    const controller = new AbortController();
    peer
      .call("externalAgents.status", { botId }, { signal: controller.signal })
      .then((status) => {
        if (!controller.signal.aborted) setKind(status.kind);
      })
      .catch(() => {
        /* Cached decoration is unavailable while disconnected. */
      });
    return () => controller.abort();
  }, [peer, botId]);
  if (kind === "unknown") return null;
  return (
    <Chip tone="warn" style={{ marginLeft: "auto", flexShrink: 0 }}>
      {t(
        kind === "quota" ? "externalAgents.status.quotaBadge" : "externalAgents.status.loginBadge",
      )}
    </Chip>
  );
}
