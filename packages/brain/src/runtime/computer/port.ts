import type { LocalToolCall, LocalToolResult } from "@pibot/agent";
import type { PolicyResult } from "@pibot/policy";
import type {
  Approval,
  ComputerApp,
  ComputerStep,
  ComputerStepAction,
  ComputerStepHandoff,
  ComputerStepMethod,
  ComputerStepPage,
  ComputerStepResult,
  Grant,
} from "@pibot/protocol-base";
import type { AuditRepo, GrantsRepo } from "@pibot/storage";
import type { ApprovalService } from "../../core/approvals.ts";
import type { LocalDependencies, ToolRunContext } from "../../core/local-types.ts";
import type { ComputerInput } from "./input.ts";

/** Only the run data used by computer operation; queue, execution and authorization stay private. */
export type ComputerRunContext = Pick<
  ToolRunContext,
  | "runWorkplace"
  | "botId"
  | "runId"
  | "messageId"
  | "conversationId"
  | "groupId"
  | "threadId"
  | "signal"
  | "language"
  | "executionTaskId"
  | "permissionGroupId"
  | "routineRunId"
  | "routineSource"
  | "routineApprovalWaitMs"
  | "routineClock"
  | "executionClock"
  | "computerElements"
  | "computerFailures"
  | "computerProgress"
  | "computerHandoffDeclined"
  | "computerShots"
  | "modelAcceptsImages"
>;
export interface ComputerStepInput {
  toolCallId: string;
  app: ComputerApp;
  method: ComputerStepMethod;
  stage: "background" | "foreground";
  target: string;
  result: ComputerStepResult;
  image?: import("@pibot/protocol-base").ImageContent;
  action?: ComputerStepAction;
  page?: ComputerStepPage;
  handoff?: ComputerStepHandoff;
}
type Tail<T extends unknown[]> = T extends [unknown, ...infer R] ? R : never;
export interface ComputerRuntime {
  computerHost(
    context: ComputerRunContext,
  ):
    | import("../../core/host-call.ts").HostCall<
        typeof import("@pibot/protocol-base").HostComputerMethods
      >
    | undefined;
  releaseComputerHost(runId: string): void;
  deps: Pick<
    LocalDependencies,
    "db" | "dataDir" | "host" | "redactor" | "logger" | "peer" | "platform"
  >;
  shutdown: { signal: AbortSignal };
  approvals: {
    audit: AuditRepo;
    grants: Pick<GrantsRepo, "create">;
    request(
      context: ComputerRunContext,
      ...args: Tail<Parameters<ApprovalService["request"]>>
    ): ReturnType<ApprovalService["request"]>;
    resolve: ApprovalService["resolve"];
    pauseExpiredChat: ApprovalService["pauseExpiredChat"];
  };
  connectionRestriction(
    context: ComputerRunContext,
    tool: string,
    canonicalApps: readonly string[],
  ): string | undefined;
  permissionScope(context: ComputerRunContext): string | undefined;
  isYolo(context: ComputerRunContext): boolean;
  grants(botId: string, context: ComputerRunContext): Grant[];
  evaluate(
    context: ComputerRunContext,
    call: { tool: string; apps: string[]; coordinates: boolean; always: ComputerApp[] },
    signal: AbortSignal,
  ): Promise<PolicyResult>;
  preauthorized(context: ComputerRunContext, ids: string[], coordinates: boolean): boolean;
  source(context: ComputerRunContext): { conversationId?: string };
  onYoloEnabled(conversationId: string, listener: () => void): () => void;
  permissionsChanged(groupId: string): Promise<void>;
  observeStep(context: ComputerRunContext, step: ComputerStep): void;
  abortRun(runId: string): Promise<void>;
  providerName(botId: string): string | null;
}
export interface ComputerGrantPort {
  authorize(
    context: ComputerRunContext,
    call: LocalToolCall,
    signal: AbortSignal,
  ): Promise<{ allow: boolean; reason?: string; yolo?: "normal" | "danger" }>;
  release(runId: string): Promise<void>;
  drained(runId: string): void;
  resolveForYolo(approval: Approval): Promise<unknown>;
  runs: { releaseForYolo(): Promise<void>; guard: { changed(): void } };
  isIdle(): boolean;
  dispose(): void;
}
export interface ComputerStepsPort {
  record(context: ComputerRunContext, input: ComputerStepInput): Promise<ComputerStep | undefined>;
  dispose(): Promise<void>;
}
export interface ComputerToolRun {
  context: ComputerRunContext;
  approveFile(path: string, signal: AbortSignal): Promise<string | undefined>;
}
/** Engine consumers never receive services, grant tokens, foreground lock objects or repositories. */
export interface ComputerUsePort {
  grants: ComputerGrantPort;
  steps: ComputerStepsPort;
  cancel(): void;
  execute(
    run: ComputerToolRun,
    prepared: { call: LocalToolCall; cwd: string },
    input: ComputerInput,
    signal: AbortSignal,
  ): Promise<LocalToolResult>;
}

export interface ComputerPrepared {
  call: LocalToolCall;
  cwd: string;
}
