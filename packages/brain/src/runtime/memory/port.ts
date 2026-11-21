import type { Bot, Memory, MemoryProposal } from "@pibot/protocol-base";

export interface MemoryPromptRequest {
  query: string;
  signal: AbortSignal;
  /** Canonical path of this run's local primary project folder; absent for a Bot's own folder. */
  project?: string;
  /** Receives the ids injected into this prompt so the run's receipt can list them. */
  onUsed?(ids: readonly string[]): void;
}

/** The narrow memory surface used by L3 run and profile orchestration. */
export interface PersonalMemoryPort {
  active(botId: string): Bot;
  writeTarget(
    botId: string,
    id: string,
    scope?: Memory["scope"],
    groupId?: string,
    project?: string,
  ): Pick<Memory, "text" | "scope"> | undefined;
  prompt(botId: string, request?: MemoryPromptRequest): string;
  /** Explicit Agent sharing, user scope only; records the included notes once. */
  sharedUser?(botId: string, signal: AbortSignal): string;
  /**
   * The notes a phone may carry offline for this Bot (user + this Bot's own, the resident
   * set the prompt would show), cut to `maxChars`. Reading them is not a use of the notes.
   */
  curated?(botId: string, request: { maxChars: number; signal: AbortSignal }): string;
  /**
   * A note a phone's offline reply proposed; it only becomes a pending proposal, never an
   * applied note. Undefined when an equal note already exists.
   */
  proposeOffline?(
    botId: string,
    messageId: string,
    input: {
      text: string;
      category: NonNullable<Memory["category"]>;
      why?: string;
      how?: string;
    },
  ): { proposalId: string } | undefined;
  list(botId: string): Memory[];
  proposals(botId: string): MemoryProposal[];
  undoable(botId: string): MemoryProposal[];
}

/** Group orchestration only consumes the prompt; mutation stays inside the memory capability. */
export interface GroupMemoryPort {
  prompt(groupId: string, botId?: string, request?: MemoryPromptRequest): string;
}

export interface MemoryPort {
  personal: PersonalMemoryPort;
  group: GroupMemoryPort;
}
