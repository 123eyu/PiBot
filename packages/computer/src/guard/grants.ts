import { createHash } from "node:crypto";
import type { HostComputerGrant } from "@pibot/protocol-base";
import { ComputerError } from "../core/errors.ts";

export interface GrantScope {
  botId: string;
  runId: string;
  apps: { id: string; name: string }[];
  expiresAt: number;
  allowCoordinates: boolean;
  foregroundAsk: boolean;
  /** Aborts when the grant is revoked, cancelling the grant's in-flight driver calls. */
  signal: AbortSignal;
}

/** Token check used before every driver call. Issuing is brain's job. */
export interface GrantVerifier {
  verify(token: string): GrantScope;
}

export type RevokeBy = { token: string } | { runId: string } | { botId: string };

export interface GrantRegistry extends GrantVerifier {
  set(grant: HostComputerGrant): void;
  revoke(by: RevokeBy): number;
  revokeAll(): number;
  size(): number;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const same = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;

// Only the stable app ID counts: a display name is chosen by the app itself, so any program could
// call itself "Keynote" and ride on a Keynote grant. (The blocklist may match names; it only refuses.)
export function grantCovers(scope: GrantScope, app: { id: string; name: string }): boolean {
  return scope.apps.some((g) => same(g.id, app.id));
}

/**
 * In-memory grants of the current brain process, keyed by token hash (the raw token is never
 * stored). Lost on host restart by design: brain re-registers or asks again. `onEmpty` lets
 * the host release resident driver helpers once no run may use them.
 */
export function createGrantRegistry(
  options: { now?: () => number; onEmpty?(): void } = {},
): GrantRegistry {
  const now = options.now ?? Date.now;
  const grants = new Map<string, GrantScope & { controller: AbortController }>();
  const drop = (key: string) => {
    const grant = grants.get(key);
    if (!grant) return 0;
    grants.delete(key);
    grant.controller.abort();
    if (grants.size === 0) options.onEmpty?.();
    return 1;
  };
  return {
    set(grant) {
      const key = hash(grant.token);
      const previous = grants.get(key);
      const controller = previous?.controller ?? new AbortController();
      grants.set(key, {
        botId: grant.botId,
        runId: grant.runId,
        apps: grant.apps.map((a) => ({ id: a.id, name: a.name })),
        expiresAt: Date.parse(grant.expiresAt),
        allowCoordinates: grant.allowCoordinates,
        foregroundAsk: grant.foregroundAsk,
        signal: controller.signal,
        controller,
      });
    },
    verify(token) {
      const key = hash(token);
      const grant = grants.get(key);
      if (!grant) throw new ComputerError("grant_invalid");
      if (grant.expiresAt <= now()) {
        drop(key);
        throw new ComputerError("grant_expired");
      }
      return grant;
    },
    revoke(by) {
      if ("token" in by) return drop(hash(by.token));
      let count = 0;
      for (const [key, grant] of [...grants]) {
        if ("runId" in by ? grant.runId === by.runId : grant.botId === by.botId) count += drop(key);
      }
      return count;
    },
    revokeAll() {
      let count = 0;
      for (const key of [...grants.keys()]) count += drop(key);
      return count;
    },
    size: () => grants.size,
  };
}
