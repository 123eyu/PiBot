import type { MobileRuntime } from "../../../runtime/runtime.ts";
import type { ChatTarget } from "../../../transport/link-port.ts";

/** The only runtime surface the control calls need, so the dev scenario can drive them directly. */
export type Caller = Pick<MobileRuntime, "call">;
/** One open chat: a DM topic of a Bot or the current topic of a group. */
export interface ChatScope {
  kind: "bot" | "group";
  id: string;
  topicId: string;
}
export const isDm = (scope: ChatScope) => scope.kind === "bot";
export function scopeTarget(scope: ChatScope): ChatTarget {
  return scope.kind === "bot"
    ? { botId: scope.id, topicId: scope.topicId }
    : { groupId: scope.id, topicId: scope.topicId };
}
export function scopeKey(scope: ChatScope | undefined) {
  return scope ? `${scope.kind}:${scope.id}:${scope.topicId}` : undefined;
}
/** DM-only controls address the Bot's topic as an execution scope. */
export function executionScope(scope: ChatScope) {
  return { botId: scope.id, conversationId: scope.topicId };
}
export function changesTarget(scope: ChatScope) {
  return scope.kind === "bot"
    ? { conversationKey: `dm:${scope.id}`, topicId: scope.topicId }
    : { conversationKey: `group:${scope.id}` };
}
