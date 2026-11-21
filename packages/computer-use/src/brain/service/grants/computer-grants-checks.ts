import type { ComputerRunContext } from "@pibot/brain/kit";
import { type ComputerApp, RpcError, sameAppId } from "@pibot/computer-use-contract/full";
import type { PolicyResult } from "@pibot/policy";

import type { ComputerContext } from "../../context.ts";

/**
 * Names the call's apps: the run's granted apps first, then the host's installed apps. For
 * `open_app` a display name resolves to its app ID; an unknown ID keeps itself as the name.
 */
export async function resolveComputerApps(
  raw: string[],
  byName: boolean,
  held: ComputerApp[],
  installed: () => Promise<ComputerApp[]>,
  resolveName?: (name: string) => Promise<string | undefined>,
  canonicalOnly = false,
): Promise<ComputerApp[]> {
  // Models often name the app ("Notes") where an ID is expected. Grants and the host match IDs
  // only, so an unresolved name would make a grant that covers nothing (every step then failed
  // with app_not_granted). A name is resolved to the one app that carries it; open_app (byName)
  // already did this, the other tools now do too. An ambiguous name stays as written.
  const named = (list: ComputerApp[], value: string) => {
    const hits = list.filter((app) => app.name.toLowerCase() === value.toLowerCase());
    return hits.length === 1 ? hits[0] : undefined;
  };
  const known = (value: string) =>
    held.find((app) => sameAppId(app.id, value)) ?? named(held, value);
  if (raw.every((value) => known(value))) return raw.map((value) => known(value) as ComputerApp);
  const apps = await installed();
  return Promise.all(
    raw.map(async (value) => {
      const direct =
        known(value) ??
        apps.find((item) => sameAppId(item.id, value)) ??
        (byName && !canonicalOnly
          ? apps.find((item) => item.name.toLowerCase() === value.toLowerCase())
          : named(apps, value));
      if (direct) return direct;
      const id = await resolveName?.(value);
      if (canonicalOnly) {
        if (!id) throw new RpcError(-32602, "computer_app_identity_unavailable");
        return apps.find((item) => sameAppId(item.id, id)) ?? { id, name: value };
      }
      return (
        (id ? apps.find((item) => sameAppId(item.id, id)) : undefined) ?? { id: value, name: value }
      );
    }),
  );
}

/** The policy gate for one operating-the-computer call (rule 6: every tool through policy). */
export async function evaluateComputerCall(
  local: ComputerContext,
  context: ComputerRunContext,
  call: { tool: string; apps: string[]; coordinates: boolean; always: ComputerApp[] },
  signal: AbortSignal,
): Promise<PolicyResult> {
  return local.evaluate(context, call, signal);
}

/** Routine preauthorization "operate the computer: app list" (never coordinates). */
export function computerPreauthorized(
  local: ComputerContext,
  context: ComputerRunContext,
  ids: string[],
  coordinates: boolean,
): boolean {
  return local.preauthorized(context, ids, coordinates);
}
