import type { TranslationKey } from "@pibot/i18n";
import { type Peer, useRpc } from "@pibot/renderer-kit";
import type { Skill } from "@pibot/skills-contract/full";
import { useCallback, useEffect, useState } from "react";
import { skillError } from "./presentation.ts";

const PAGE = 50;

/**
 * The Bot's (or group member's) assigned skills, including built-in methods, so the panel and
 * connections catalog agree. Built-in methods remain planning references, not runnable workflows.
 */
export function useSkillPage(botId: string, groupId: string | undefined) {
  const { peer } = useRpc();
  const [rows, setRows] = useState<Skill[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<TranslationKey>();
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((n) => n + 1), []);
  const load = useCallback(
    async (current: Peer, before?: string) => {
      const page = await current.call("skills.list", {
        groupId,
        botId,
        before,
        limit: PAGE,
      });
      if (page.some((skill) => skill.botId !== botId)) throw new Error("Skill owner changed");
      return page;
    },
    [botId, groupId],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new peer or Bot must not show another Bot's skills.
  useEffect(() => setRows([]), [peer, botId, groupId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Revision requests a fresh first page.
  useEffect(() => {
    if (!peer) return;
    let active = true;
    setLoading(true);
    setError(undefined);
    void load(peer)
      .then((page) => {
        if (!active) return;
        setRows(page);
        setMore(page.length === PAGE);
      })
      .catch((failure: unknown) => {
        if (active) setError(skillError(failure));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [peer, load, revision]);
  const next = async () => {
    if (!peer || loading) return;
    setLoading(true);
    try {
      const page = await load(peer, rows.at(-1)?.id);
      setRows((old) => {
        const ids = new Set(old.map((row) => row.id));
        return [...old, ...page.filter((row) => !ids.has(row.id))];
      });
      setMore(page.length === PAGE);
    } catch (failure) {
      setError(skillError(failure));
    } finally {
      setLoading(false);
    }
  };
  const replace = (skill: Skill) =>
    setRows((list) => list.map((row) => (row.id === skill.id ? skill : row)));
  return { rows, more, loading, error, reload, next, replace };
}
