import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ComputerRunContext, HostCall } from "@pibot/brain/kit";
import {
  COMPUTER_TASK_GRANT_MS,
  type ComputerApp,
  type ComputerGrant,
  type ComputerGrantDuration,
  type HostComputerMethods,
  sameAppId,
} from "@pibot/computer-use-contract/full";
import { type AuditRepo, ComputerGrantsRepo, computerTokenHash, transaction } from "@pibot/storage";

/** A grant held by one run: the database row (hash only) and the raw token, in memory only. */
export interface RunGrant {
  row: ComputerGrant;
  token: string;
  apps: ComputerApp[];
  expiresAt: number;
}
export interface GrantOptions {
  apps: ComputerApp[];
  duration: ComputerGrantDuration;
  foregroundAsk: boolean;
  allowCoordinates: boolean;
  /** Keeps an extended grant's original deadline instead of starting a new window. */
  expiresAt?: string;
}

/** 32 random bytes, base64url (43 chars), as `ComputerGrantTokenSchema` expects. */
export function newGrantToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: computerTokenHash(token) };
}

/** "task" is the card's 30 minutes; "today" ends at the next local midnight. */
export function grantExpiry(duration: ComputerGrantDuration, now = new Date()): Date {
  if (duration === "task") return new Date(now.getTime() + COMPUTER_TASK_GRANT_MS);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
}

export function unionApps(...lists: readonly (readonly ComputerApp[])[]): ComputerApp[] {
  const result: ComputerApp[] = [];
  for (const list of lists)
    for (const app of list)
      if (!result.some((held) => sameAppId(held.id, app.id))) result.push(app);
  return result;
}

export function coversApps(grant: RunGrant, ids: readonly string[]): boolean {
  return ids.every((id) => grant.apps.some((app) => sameAppId(app.id, id)));
}

/**
 * Writes the grant row (the blocklist is re-checked by the repository in the same transaction)
 * and its audit entry; a previous grant of the run is revoked so one run holds one token.
 */
export function createGrantRow(
  db: DatabaseSync,
  audit: AuditRepo,
  input: {
    context: ComputerRunContext;
    options: GrantOptions;
    hash: string;
    approvalId: string | null;
    previous?: RunGrant;
    actor: "user" | "system";
    reasonCode: string;
  },
): ComputerGrant {
  const { context, options } = input;
  const repo = new ComputerGrantsRepo(db);
  return transaction(db, () => {
    if (input.previous) repo.revoke(input.previous.row.id);
    const row = repo.create({
      botId: context.botId,
      runId: context.runId,
      apps: options.apps.map((app) => app.id),
      duration: options.duration,
      expiresAt: options.expiresAt ?? grantExpiry(options.duration).toISOString(),
      foregroundAsk: options.foregroundAsk,
      allowCoordinates: options.allowCoordinates,
      approvalId: input.approvalId,
      tokenHash: input.hash,
    });
    audit.append({
      botId: context.botId,
      runId: context.runId,
      kind: "grant.created",
      summary: "Computer operation granted / 已授权操作电脑",
      detail: {
        grantId: row.id,
        category: "computer",
        programs: row.apps,
        actor: input.actor,
        reasonCode: input.reasonCode,
        source: context.routineSource ?? "chat",
        ...(context.routineRunId ? { routineRunId: context.routineRunId } : {}),
        ...(input.approvalId ? { approvalId: input.approvalId } : {}),
        ...(row.allowCoordinates ? { target: "coordinates" } : {}),
      },
    });
    return row;
  });
}

/** Registers the token with the background process; only then may driver calls use it. */
export async function registerGrant(
  host: HostCall<typeof HostComputerMethods>,
  grant: RunGrant,
  signal: AbortSignal,
): Promise<void> {
  await host.call(
    "host.computer.grants.set",
    {
      token: grant.token,
      botId: grant.row.botId,
      runId: grant.row.runId,
      apps: grant.apps.map((app) => ({ id: app.id, name: app.name })),
      expiresAt: grant.row.expiresAt,
      allowCoordinates: grant.row.allowCoordinates,
      foregroundAsk: grant.row.foregroundAsk,
    },
    AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  );
}
