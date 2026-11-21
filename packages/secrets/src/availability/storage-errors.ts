// Subpath: secrets loads in the owner before the brain fork; the root evaluates every schema.
import { RpcError, RpcErrorCodes } from "@pibot/protocol-base/peer";

const reasons = [
  "secure_storage_session_pending",
  "secure_storage_timeout",
  "secure_storage_busy",
  "secure_storage_closed",
  "secure_storage_insecure_backend",
  "secrets_unavailable",
] as const;
export type SecretStorageReason = (typeof reasons)[number];

/** Only fixed codes cross the keyring boundary; native errors may contain sensitive details. */
export function secretStorageReason(error: unknown): SecretStorageReason {
  if (error instanceof RpcError) {
    const reason = reasons.find((value) => value === error.message);
    if (reason) return reason;
    if (error.code === RpcErrorCodes.timeout) return "secure_storage_timeout";
  }
  return "secrets_unavailable";
}
