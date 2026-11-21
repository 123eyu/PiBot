import type { MemoryProposal } from "@pibot/protocol";
import { useT } from "@pibot/renderer-kit";

export function MemoryScopeLabel({ scope }: Pick<MemoryProposal, "scope">) {
  const t = useT();
  return <p>{t(`workspace.memoryScope.${scope ?? "bot"}`)}</p>;
}
