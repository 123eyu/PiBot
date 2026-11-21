import { CHATGPT_PLAN_PROVIDERS } from "@pibot/protocol-base";
import { useEffect, useState } from "react";
import { z } from "zod";
import { useRuntime } from "../../runtime/context.tsx";
import { settingsCacheKey } from "../../storage/settings-cache.ts";

/**
 * Owner rule: a ChatGPT-plan sign-in is never handed to a phone; two copies refreshing the same
 * OAuth token would cancel each other. Such a Bot has no offline model, and the manifest cannot
 * say why without breaking older phones' strict schema, so the reason comes from the Bot's
 * profile the phone keeps (features/sync/catalog-sync.ts). Since 2026-11-15 the plan is
 * its own provider, so the Bot's provider id alone says it runs on the plan.
 */
const PLAN_PROVIDERS = new Set(CHATGPT_PLAN_PROVIDERS);
const CachedProfileSchema = z.object({
  profile: z.object({ bot: z.object({ modelProvider: z.string().nullish() }) }),
});

/** The Bots among `botIds` whose stored profile says they run on the ChatGPT plan. */
export function usePlanBots(computerId: string | undefined, botIds: readonly string[]) {
  const runtime = useRuntime();
  const [plan, setPlan] = useState<ReadonlySet<string>>(new Set());
  const ids = botIds.join(",");
  useEffect(() => {
    if (!computerId || !ids) return;
    let live = true;
    void Promise.all(
      ids.split(",").map(async (botId) => {
        const stored = await runtime.storage.data
          .get(settingsCacheKey(computerId, `bot:${botId}:profile`))
          // A missing copy only means no reason is shown; the Bot stays unavailable either way.
          .catch(() => undefined);
        const parsed = CachedProfileSchema.safeParse(stored);
        const provider = parsed.success ? parsed.data.profile.bot.modelProvider : undefined;
        return provider && PLAN_PROVIDERS.has(provider) ? botId : undefined;
      }),
    ).then((found) => {
      if (live) setPlan(new Set(found.filter((id): id is string => !!id)));
    });
    return () => {
      live = false;
    };
  }, [runtime, computerId, ids]);
  return plan;
}
