import type { GitConfigurationIntent, RegisteredBranchConfigurationPlan } from "@pibot/execution";
import type { ManagedBranchConfigBinding, ManagedConfigCall } from "@pibot/protocol-base";
import type { ToolRunContext } from "../../core/local-types.ts";

export interface ManagedConfigOwnerProof {
  readonly call: Readonly<ManagedConfigCall>;
  acquirePublicationRoots(signal: AbortSignal): Promise<void>;
  assertCurrentOwner(): void;
  ownsQueueEntry(
    entry: Pick<ToolRunContext, "botId" | "runId" | "signal" | "conversationId" | "groupId"> & {
      drained?: boolean;
    },
  ): boolean;
}
/** The implementation is issued by AF8 and never projected to policy, RPC or model state. */
export interface ManagedBranchConfigurationHandle {
  readonly binding: Readonly<ManagedBranchConfigBinding>;
  readonly plan: RegisteredBranchConfigurationPlan;
  assertCurrent(requirement: Readonly<ManagedBranchConfigBinding>): void;
  withPublicationLease<T>(
    owner: ManagedConfigOwnerProof,
    signal: AbortSignal,
    operation: (assertLeaseCurrent: () => void) => Promise<T>,
  ): Promise<T>;
  dispose(): Promise<void>;
}
export interface ManagedBranchConfigurationPort {
  prepare(
    request: {
      context: ToolRunContext;
      toolCallId: string;
      intent: GitConfigurationIntent;
      primaryRootId: string;
    },
    signal: AbortSignal,
  ): Promise<ManagedBranchConfigurationHandle | undefined>;
}
