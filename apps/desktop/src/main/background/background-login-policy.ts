import type { BackgroundPreferences, IndependentBackgroundState } from "@pibot/protocol/background";
import type { createBackgroundManagement } from "./background-management.ts";
import { applyBackgroundPreferences } from "./background-preferences.ts";

type Management = IndependentBackgroundState["management"];

/**
 * Run once per owner after the brain is ready (off the startup path):
 * - Default: a new install (onboarding not yet completed) starts the service at sign-in; an
 *   upgrade keeps its saved value (installs and upgrades never switched this on before). Decided
 *   once per data directory and recorded, so turning it off stays off.
 * - Repair: an item withdrawn by an explicit stop is registered again while the preference is on.
 * Only where the platform manager is actually available (packaged build, default data dir).
 */
export async function applyLoginPolicy(options: {
  platform: NodeJS.Platform;
  preferences: BackgroundPreferences;
  onboardingCompleted: boolean;
  management: ReturnType<typeof createBackgroundManagement>;
  write(value: BackgroundPreferences): Promise<BackgroundPreferences>;
}): Promise<{
  preferences: BackgroundPreferences;
  management: Management;
  defaulted: boolean;
}> {
  const current = await options.management.query();
  if (!current.available)
    return { preferences: options.preferences, management: current, defaulted: false };
  if (options.preferences.loginDefaultApplied !== true) {
    // Linux: the switch works, but the default waits for a real sign-in acceptance.
    const fresh = !options.onboardingCompleted && options.platform !== "linux";
    const result = await applyBackgroundPreferences({
      platform: options.platform,
      previous: options.preferences,
      patch: fresh ? { startAtLogin: true } : {},
      management: options.management,
      write: (value) => options.write({ ...value, loginDefaultApplied: true }),
    });
    return { ...result, defaulted: fresh && result.preferences.startAtLogin };
  }
  if (options.preferences.startAtLogin && !current.enabled) {
    await options.management.register(AbortSignal.timeout(20_000));
    return {
      preferences: options.preferences,
      management: await options.management.query(),
      defaulted: false,
    };
  }
  return { preferences: options.preferences, management: current, defaulted: false };
}
