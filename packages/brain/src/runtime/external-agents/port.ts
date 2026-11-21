import type { Bot, ImageContent } from "@pibot/protocol-base";
import type { ImageRunHost } from "../media/images-port.ts";
import type { ChatRun } from "../queue/chat-run.ts";

/** The host services an external-agent run settles with; same set an image run gets. */
export type ExternalAgentRunHost = ImageRunHost;

/**
 * A Bot of kind "agent" thinks in an external coding agent (Codex, Claude Agent,
 * …) over ACP. The run queue keeps admission, the topic slot and stop; the external-agents
 * capability owns the agent process, the session and the translation of its updates.
 */
export interface ExternalAgentsPort {
  run(
    deps: ExternalAgentRunHost,
    run: ChatRun,
    text: string,
    bot: Bot,
    images: ImageContent[],
  ): Promise<void>;
  /**
   * Whether this agent Bot can take a group plan step here: "ok", "unconfirmed" (Windows: the
   * user has not confirmed running it unisolated) or "unavailable" (no program / no isolation).
   */
  stepReadiness?(botId: string): "ok" | "unconfirmed" | "unavailable";
}
