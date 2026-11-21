import type { CapabilityContext } from "@pibot/brain/kit";
import type { Approval } from "@pibot/credentials-contract/full";
import type { AuditRepo } from "@pibot/storage";

/** A saved-account service has no authority to enqueue, execute or widen runtime permissions. */
export interface CredentialContext {
  deps: Pick<CapabilityContext, "db" | "host" | "redactor" | "logger" | "peer"> & {
    platform: NodeJS.Platform;
  };
  shutdown: { signal: AbortSignal };
  approvals: {
    audit: AuditRepo;
    pauseExpiredChat(id: string): void;
    repo: { get(id: string): Approval | undefined };
    resolve(
      id: string,
      decision: "allow" | "deny",
      remember: boolean,
      preauthorize: boolean,
    ): Promise<{ ok: true }>;
  };
  browser: {
    refreshGroupGoogleCompat(id: string, signal: AbortSignal): Promise<void>;
    refreshGoogleCompat(id: string, signal: AbortSignal): Promise<void>;
  };
}
