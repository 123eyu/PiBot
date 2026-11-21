import type { MemoryToolInput } from "./memory-input.ts";
import type { OrganizationProposal } from "./memory-organization.ts";

/**
 * A merge is two kinds of change at once: the surviving note is rewritten with the combined text
 * and the others are removed. They travel as separate proposals because that is what the existing
 * memory proposal model accepts; the user confirms each one.
 */
export function organizationInputs(
  scope: "user" | "bot",
  proposal: OrganizationProposal,
): MemoryToolInput[] {
  const [head = "", ...rest] = proposal.ids;
  if (proposal.action === "remove")
    return proposal.ids.map((id) => ({ tool: "memory_remove", args: { scope, id } }));
  const note = {
    ...(proposal.why === undefined ? {} : { why: proposal.why }),
    ...(proposal.how === undefined ? {} : { how: proposal.how }),
  };
  const rewrite: MemoryToolInput = {
    tool: "memory_update",
    args: {
      scope,
      id: head,
      text: proposal.text ?? "",
      // A null category means "no category", which the tool input cannot express as a change;
      // leaving it out keeps the surviving note's own category instead of clearing it.
      ...(proposal.category ? { category: proposal.category } : {}),
      ...note,
    },
  };
  return proposal.action === "merge"
    ? [rewrite, ...rest.map((id) => ({ tool: "memory_remove" as const, args: { scope, id } }))]
    : [rewrite];
}
