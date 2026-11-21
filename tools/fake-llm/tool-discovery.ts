import type { Reply } from "./scenario.ts";

/** Scripted models must discover deferred tools through the same gate as real models. */
export function withToolDiscovery(
  replies: Reply[],
  groupFor: (name: string) => { id: string } | undefined,
): Reply[] {
  return replies.flatMap((reply) => {
    const groups = [
      ...new Set(
        (reply.toolCalls ?? []).flatMap((call) => {
          const group = groupFor(call.name);
          return group ? [group.id] : [];
        }),
      ),
    ];
    if (!groups.length) return [reply];
    return [
      {
        toolCalls: [{ name: "tool_discover", arguments: { groups } }],
        delayMs: reply.delayMs ?? 0,
      },
      reply,
    ];
  });
}
