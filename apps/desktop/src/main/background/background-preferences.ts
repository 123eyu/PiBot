import {
  type BackgroundPreferences,
  BackgroundPreferencesSchema,
  type IndependentBackgroundState,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";
import type { createBackgroundManagement } from "./background-management.ts";

export async function applyBackgroundPreferences(options: {
  platform: NodeJS.Platform;
  previous: BackgroundPreferences;
  patch: Partial<BackgroundPreferences>;
  management: ReturnType<typeof createBackgroundManagement>;
  write(value: BackgroundPreferences): Promise<BackgroundPreferences>;
}): Promise<{
  preferences: BackgroundPreferences;
  management: IndependentBackgroundState["management"];
}> {
  const next = BackgroundPreferencesSchema.parse({ ...options.previous, ...options.patch });
  // An unrelated tray patch must not register a saved login preference as a side effect.
  const managesLogin =
    options.patch.startAtLogin !== undefined || next.startAtLogin !== options.previous.startAtLogin;
  const before = await options.management.query();
  if (
    (next.exitBehavior === "continue" &&
      options.platform !== "darwin" &&
      options.platform !== "win32") ||
    (managesLogin && next.startAtLogin && !before.available)
  )
    throw new RpcError(RpcErrorCodes.unsupported, "background_platform_unavailable");
  // Starting at sign-in no longer requires "continue". With "stop" the sign-in service waits
  // for the window, and quitting the window still stops it until the next sign-in.
  const change =
    managesLogin &&
    (next.startAtLogin !== options.previous.startAtLogin || (next.startAtLogin && !before.enabled));
  if (change) {
    if (next.startAtLogin) await options.management.register(AbortSignal.timeout(20_000));
    else await options.management.disableLogin(AbortSignal.timeout(10_000));
  }
  try {
    const preferences = await options.write(next);
    return { preferences, management: await options.management.query() };
  } catch (error) {
    if (change) {
      if (options.previous.startAtLogin)
        await options.management.register(AbortSignal.timeout(20_000));
      else await options.management.disableLogin(AbortSignal.timeout(10_000));
    }
    throw error;
  }
}
