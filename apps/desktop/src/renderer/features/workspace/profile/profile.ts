import type { MethodResults } from "@pibot/protocol";

// Structural RPC validation cannot establish that the response belongs to this requested Bot.
export function checkedProfile(profile: MethodResults["bots.profile"], botId: string) {
  if (
    profile.bot.id !== botId ||
    profile.memories.some((memory) => memory.scope !== "user" && memory.botId !== botId) ||
    profile.proposals.some((proposal) => proposal.botId !== botId) ||
    (profile.undoable ?? []).some(
      (proposal) => proposal.botId !== botId || proposal.status !== "accepted",
    )
  )
    throw new Error("Profile target mismatch");
  return profile;
}
