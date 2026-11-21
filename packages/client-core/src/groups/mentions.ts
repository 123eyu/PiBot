import type { Bot } from "@pibot/protocol";

/** The `@query` being typed right before the caret, or undefined when the caret is not in one. */
export function mentionQuery(text: string, caret: number): string | undefined {
  return /(?:^|[\s([{，。；：,;:])@([^@\n]*)$/u.exec(text.slice(0, caret))?.[1];
}
/** Current members whose name (or ID prefix) matches the typed `@query`. */
export function mentionOptions(query: string, members: readonly Bot[]): Bot[] {
  const needle = query.toLocaleLowerCase();
  return members.filter(
    (b) => !b.archivedAt && (b.name.toLocaleLowerCase().includes(needle) || b.id.startsWith(query)),
  );
}
/**
 * IDs of picked Bots whose `@name` is still in the text (as many picks per name as the text has
 * tokens), current members only, at most six like the message's own mention list.
 */
export function pickedMentions(
  text: string,
  picks: readonly { id: string; name: string }[],
  members: readonly Bot[],
): string[] {
  const memberIds = new Set(members.filter((b) => !b.archivedAt).map((b) => b.id));
  const left = new Map<string, number>();
  const ids: string[] = [];
  for (const { id, name } of picks) {
    if (!memberIds.has(id) || ids.includes(id)) continue;
    const count = left.get(name) ?? text.split(`@${name}`).length - 1;
    if (count <= 0) continue;
    left.set(name, count - 1);
    ids.push(id);
  }
  return ids.slice(0, 6);
}
