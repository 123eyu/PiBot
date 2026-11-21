import { near } from "./secure-input.ts";
import { type ElementFacts, identityKey } from "./tree.ts";

export interface Identified {
  token: string;
  facts: ElementFacts;
}

/**
 * The identity of an element across two reads: role, label and the whole ancestor chain, which
 * `toElements` stores on the facts so they stand on their own. A chain that could not
 * be read (a truncated tree) proves nothing and never matches.
 */
function related(was: ElementFacts, now: ElementFacts): boolean {
  // One string on both sides: this is the same comparison the password scan's certification makes
  // (`tree-read.ts`), so "the same element" means the same thing before acting and before input.
  const before = identityKey(was);
  const after = identityKey(now);
  return before !== undefined && before === after;
}

/**
 * The element `was` names, in the read taken right before an action; `undefined` when
 * that read no longer holds it or holds more than one candidate, which callers turn into
 * `stale_element` rather than acting on a guess.
 *
 * A labelled element is allowed to have moved: a list that reordered keeps its rows, and acting on
 * the row whose role, label and whole ancestor chain are the row that was read is not a guess.
 * Identical siblings (three buttons both called "Same") are the case the chain cannot settle, so
 * their position within that group decides — and only while the group keeps its size, since a
 * group that grew or shrank means the element in that place is a different one. An
 * unlabelled element has no identity at all and only counts when neither read moved it.
 */
export function verifyAtActionTime(
  was: ElementFacts,
  current: Map<string, ElementFacts>,
): Identified | undefined {
  const unlabelled = !was.label?.trim();
  const candidates: Identified[] = [];
  for (const [token, facts] of current) {
    if (!related(was, facts)) continue;
    if (
      unlabelled &&
      (was.frame === undefined || facts.frame === undefined || !near(was.frame, facts.frame))
    )
      continue;
    candidates.push({ token, facts });
  }
  if (candidates.length === 1) return candidates[0];
  if (!candidates.length) return undefined;
  // Same role, label and ancestors more than once: where it sits among those siblings is the only
  // remaining tell. Two elements can only be told apart if exactly one of them took its place.
  const at = candidates.filter(
    ({ facts }) => facts.ordinal === was.ordinal && facts.siblings === was.siblings,
  );
  return at.length === 1 ? at[0] : undefined;
}
