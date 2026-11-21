import type { ServiceContext } from "./context.ts";
import { ComputerError } from "./errors.ts";

const MAX_APP_NAMES = 128;
const assertActive = (signal: AbortSignal) => {
  if (signal.aborted) throw new ComputerError("cancelled", "app_resolution");
};

/** OS identity only; callers still match their own installed list or granted IDs. */
export async function resolveAppName(
  ctx: ServiceContext,
  name: string,
  signal: AbortSignal,
  refresh = false,
): Promise<string | undefined> {
  assertActive(signal);
  if (!ctx.driver.resolveAppName) return undefined;
  const key = name.toLowerCase();
  if (refresh) ctx.appNames?.delete(key);
  let id = ctx.appNames?.get(key);
  if (!id) {
    try {
      id = await ctx.driver.resolveAppName(name, signal);
    } catch (error) {
      assertActive(signal);
      throw error;
    }
    assertActive(signal);
    // Do not retain misses: installing an app must be observable by the next request.
    if (id) {
      ctx.appNames ??= new Map();
      const cache = ctx.appNames;
      if (cache.size >= MAX_APP_NAMES) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, id);
    }
  }
  assertActive(signal);
  return id;
}
