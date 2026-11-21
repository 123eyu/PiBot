import { RpcError, RpcErrorCodes } from "../core/peer.ts";

/** Shared presentation/admission parsing: typing an @name has the same recipient as picking it. */
export function resolveGroupMentions(
  members: readonly { id: string; name: string }[],
  text: string,
  picked: readonly string[] = [],
): string[] {
  const memberIds = new Set(members.map((b) => b.id));
  if (picked.some((id) => !memberIds.has(id)))
    throw new RpcError(RpcErrorCodes.mentionUnresolved, "mention_not_member");
  const byName = new Map<string, string[]>();
  for (const b of members) byName.set(b.name, [...(byName.get(b.name) ?? []), b.id]);
  const ordered = members.slice().sort((a, b) => b.name.length - a.name.length);
  const unusedPicks = [...picked];
  const result: string[] = [],
    seen = new Set<string>();
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "@" || (i > 0 && !/[\s([{，。；：,;:]/u.test(text[i - 1] ?? ""))) continue;
    const rest = text.slice(i + 1);
    const ends = (length: number) => /^(?:$|[\s\p{P}])/u.test(rest.slice(length));
    let id = ordered.find((b) => rest.startsWith(b.id) && ends(b.id.length))?.id;
    let length = id?.length ?? 0;
    if (!id) {
      const named = ordered.find((b) => rest.startsWith(b.name) && ends(b.name.length));
      if (!named) continue;
      const candidates = byName.get(named.name) ?? [];
      const pick = unusedPicks.findIndex((p) => candidates.includes(p));
      if (pick >= 0) id = unusedPicks.splice(pick, 1)[0];
      else if (candidates.length === 1) id = candidates[0];
      else throw new RpcError(RpcErrorCodes.mentionUnresolved, "mention_ambiguous");
      length = named.name.length;
    }
    if (id && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
    i += length;
  }
  return result;
}
