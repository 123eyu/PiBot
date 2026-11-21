import type { Bot } from "@pibot/protocol";
import { useRpc, useSettings } from "@pibot/renderer-kit";
import { useEffect, useState } from "react";

type ByLanguage = { zh: string[]; en: string[] };
const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * A Bot keeps the suggestions of the language it was created in. Maintainers 2026-11-13: while they are
 * still the role's own, show the role's set in the current interface language; suggestions the
 * user edited stay exactly as written.
 */
export function useStarters(bot: Pick<Bot, "quickPrompts" | "role"> | undefined) {
  const { peer } = useRpc();
  const { language } = useSettings();
  const saved = bot?.quickPrompts ?? [];
  const roleId = bot?.role?.id;
  const [role, setRole] = useState<{ id: string; prompts?: ByLanguage }>();
  useEffect(() => {
    if (!peer || !roleId) return;
    const abort = new AbortController();
    void peer.call("builtin.catalog", undefined, { signal: abort.signal, timeoutMs: 10000 }).then(
      (catalog) => {
        if (abort.signal.aborted) return;
        const found = catalog.roles.find((item) => item.id === roleId);
        setRole({ id: roleId, prompts: found?.quickPromptsByLanguage });
      },
      () => {
        // The saved suggestions remain usable when the catalog cannot be read.
        if (!abort.signal.aborted) setRole({ id: roleId });
      },
    );
    return () => abort.abort();
  }, [peer, roleId]);
  const prompts = role?.id === roleId ? role?.prompts : undefined;
  if (!prompts || !saved.length) return saved;
  const current = language === "zh" ? prompts.zh : prompts.en;
  return (same(saved, prompts.zh) || same(saved, prompts.en)) && current.length ? current : saved;
}
