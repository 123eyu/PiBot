import type { MemoryOwner } from "@pibot/protocol";
import { MemoryScopeView } from "./settings/MemoryScopeView.tsx";

export function MemorySummary({ owner }: { owner: MemoryOwner }) {
  return (
    <div data-memory-summary={owner.scope} data-memory-owner={owner.ownerId}>
      <MemoryScopeView
        key={`${owner.scope}:${owner.ownerId}`}
        owner={{ scope: owner.scope, ownerId: owner.ownerId }}
      />
    </div>
  );
}
