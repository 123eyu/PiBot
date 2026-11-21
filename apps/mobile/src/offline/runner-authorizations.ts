import { verifyPhoneControl } from "@pibot/link";
import {
  type PhoneControlGrant,
  PhoneControlGrantsSchema,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";
import type { OfflineCall } from "./sync.ts";
import type { KeyVault } from "./vault.ts";

export const RUNNER_AUTHORIZATION_SLOT = "runner-controls-v1";
export async function pullRunnerAuthorizations(
  call: OfflineCall,
  vault: KeyVault,
  computerId: string,
  issuer: string,
  signal: AbortSignal,
) {
  const grants: PhoneControlGrant[] = [];
  let after: string | undefined;
  try {
    do {
      const answer = await call("remote.runnerControl.pull", { after }, signal, 20_000);
      for (const value of answer.grants) {
        const grant = verifyPhoneControl(value, issuer);
        if (grant.body.enabled && grant.body.expiresAt > Date.now()) grants.push(grant);
      }
      after = answer.nextAfter ?? undefined;
      if (grants.length > 100) throw new Error("runner_authorization_capacity");
      signal.throwIfAborted();
    } while (after);
    signal.throwIfAborted();
    if (grants.length)
      await vault.set(computerId, RUNNER_AUTHORIZATION_SLOT, JSON.stringify(grants));
    else await vault.remove(computerId, RUNNER_AUTHORIZATION_SLOT);
    if (signal.aborted) {
      await vault.remove(computerId, RUNNER_AUTHORIZATION_SLOT);
      signal.throwIfAborted();
    }
  } catch (error) {
    if (error instanceof RpcError && error.code === RpcErrorCodes.methodNotFound) {
      await vault.remove(computerId, RUNNER_AUTHORIZATION_SLOT);
      return;
    }
    throw error;
  }
}
export async function readRunnerAuthorizations(
  vault: KeyVault,
  computerId: string,
  issuer: string,
) {
  const value = await vault.get(computerId, RUNNER_AUTHORIZATION_SLOT);
  if (!value) return [];
  if (value.length > 140_000) throw new Error("runner_authorization_capacity");
  return PhoneControlGrantsSchema.parse(JSON.parse(value))
    .map((g) => verifyPhoneControl(g, issuer))
    .filter(
      (g) => g.body.enabled && g.body.issuedAt <= Date.now() && g.body.expiresAt > Date.now(),
    );
}
