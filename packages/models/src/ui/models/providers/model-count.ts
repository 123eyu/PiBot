import type { useT } from "@pibot/renderer-kit";

/**
 * A local / custom endpoint lists its models only after it is set up, so "Models: 0" before that
 * read like a broken provider (docs guide 2026-11-14); it says "not set up" instead.
 */
export function modelCountText(
  provider: { auth: string; modelCount: number; configured: boolean },
  t: ReturnType<typeof useT>,
) {
  return provider.auth === "custom" && !provider.configured && provider.modelCount === 0
    ? t("models.notSetUp")
    : t("models.modelCount", { count: provider.modelCount });
}
