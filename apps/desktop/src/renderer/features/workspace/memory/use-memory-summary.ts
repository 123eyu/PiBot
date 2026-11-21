import type { MemoryOwner, MethodResults } from "@pibot/protocol";
import { useRpc, useRpcEvent } from "@pibot/renderer-kit";
import { useEffect, useState } from "react";

/** Keep statistics bound to their connection and owner, including while a new read is pending. */
export function useMemorySummary(owner: MemoryOwner) {
  const { peer } = useRpc();
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<{
    peer: typeof peer;
    scope: MemoryOwner["scope"];
    ownerId: string;
    revision: number;
    data?: MethodResults["memory.summary"];
    failed?: boolean;
  }>();
  useRpcEvent("memory.changed", (event) => {
    if (event.scope === owner.scope && event.ownerId === owner.ownerId)
      setRevision((value) => value + 1);
  });
  useRpcEvent("groups.resources.changed", (event) => {
    if (owner.scope === "group" && event.groupId === owner.ownerId && event.kind === "memory")
      setRevision((value) => value + 1);
  });
  useEffect(() => {
    const controller = new AbortController();
    const identity = { peer, scope: owner.scope, ownerId: owner.ownerId, revision };
    if (peer)
      void peer
        .call(
          "memory.summary",
          { scope: owner.scope, ownerId: owner.ownerId },
          {
            signal: controller.signal,
            timeoutMs: 30_000,
          },
        )
        .then((data) => {
          if (!controller.signal.aborted) setSnapshot({ ...identity, data });
        })
        .catch(() => {
          if (!controller.signal.aborted) setSnapshot({ ...identity, failed: true });
        });
    return () => controller.abort();
  }, [peer, owner.scope, owner.ownerId, revision]);
  const current =
    snapshot &&
    snapshot.peer === peer &&
    snapshot.scope === owner.scope &&
    snapshot.ownerId === owner.ownerId &&
    snapshot.revision === revision
      ? snapshot
      : undefined;
  return { data: current?.data, failed: !peer || current?.failed === true };
}
