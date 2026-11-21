import type { TranslationKey } from "@pibot/i18n";
import { type Peer, useRpc } from "@pibot/renderer-kit";
import type { SkillCatalogItem } from "@pibot/skills-contract/full";
import { useCallback, useEffect, useRef, useState } from "react";
import { skillError } from "./presentation.ts";

const PAGE = 50;
const MEMBER_PAGE = 200;
// The catalog folds copies by name (ignoring case) and description; a member's copy matches the same way.
const keyOf = (name: string, description: string) => `${name.toLowerCase()}\0${description}`;

/**
 * A catalog row only says which groups have *some* member using it, so in a group the member's
 * own group skills decide what is already given. Bounded: a member holds far fewer than this.
 */
async function memberSkills(peer: Peer, botId: string, groupId: string, signal: AbortSignal) {
  const keys = new Set<string>();
  let before: string | undefined;
  for (let page = 0; page < 10; page++) {
    const rows = await peer.call(
      "skills.list",
      { groupId, botId, before, limit: MEMBER_PAGE },
      { signal },
    );
    for (const row of rows) if (row.enabled) keys.add(keyOf(row.name, row.description));
    if (rows.length < MEMBER_PAGE) break;
    before = rows.at(-1)?.id;
  }
  return keys;
}

/** The connections page's skill list (`skills.catalog`) with whether this Bot / member has each. */
export function useCatalogChoices(botId: string, groupId: string | undefined) {
  const { peer } = useRpc();
  const [items, setItems] = useState<SkillCatalogItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [member, setMember] = useState<ReadonlySet<string>>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<TranslationKey>();
  const [revision, setRevision] = useState(0);
  const owner = useRef<AbortController>(undefined);
  const retry = useCallback(() => setRevision((n) => n + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Revision requests a fresh first page.
  useEffect(() => {
    if (!peer) return;
    const controller = new AbortController();
    owner.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    setLoading(true);
    setError(undefined);
    void Promise.all([
      peer.call("skills.catalog", { limit: PAGE }, { signal }),
      groupId ? memberSkills(peer, botId, groupId, signal) : undefined,
    ])
      .then(([page, keys]) => {
        if (controller.signal.aborted) return;
        setItems(page.items);
        setCursor(page.nextCursor);
        setMember(keys);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(skillError(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [peer, botId, groupId, revision]);
  const next = async () => {
    const controller = owner.current;
    if (!peer || !cursor || loading || !controller) return;
    setLoading(true);
    try {
      const page = await peer.call(
        "skills.catalog",
        { cursor, limit: PAGE },
        { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) },
      );
      if (controller.signal.aborted) return;
      setItems((old) => {
        const keys = new Set(old.map((item) => item.key));
        return [...old, ...page.items.filter((item) => !keys.has(item.key))];
      });
      setCursor(page.nextCursor);
    } catch (failure) {
      if (!controller.signal.aborted) setError(skillError(failure));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };
  const isOn = (item: SkillCatalogItem) =>
    groupId ? !!member?.has(keyOf(item.name, item.description)) : item.bots.includes(botId);
  return { items, more: !!cursor, loading, error, retry, next, isOn };
}
