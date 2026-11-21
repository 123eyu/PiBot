import type { SourceAccess } from "@pibot/execution/semantic";
import { BotsRepo } from "@pibot/storage";
import type { ToolRunContext } from "../../core/local-types.ts";
import type { LocalService } from "../../local-service.ts";
import {
  FolderLockError,
  type WriteLockOwner,
} from "../../resources/workplaces/folder-write-lock.ts";
import type { ChangesScope } from "../workspaces/types.ts";
import { captureReview } from "./review-snapshot.ts";

export class ReviewCaptureError extends Error {
  constructor(
    readonly stage: "lock" | "snapshot",
    readonly holderName?: string,
  ) {
    super(stage === "lock" ? "review_lock_timeout" : "review_snapshot_timeout");
    this.name = "ReviewCaptureError";
  }
  text(language: "zh" | "en") {
    if (this.stage === "snapshot")
      return language === "zh"
        ? "独立审查尚未启动：生成代码快照超时。请稍后重试。"
        : "Independent review has not started: creating the code snapshot timed out. Try again later.";
    return language === "zh"
      ? `独立审查尚未启动：等待${this.holderName || "其他 Bot"}释放工作区超时。请等它完成本轮后再发起审查。`
      : `Independent review has not started: timed out waiting for ${this.holderName || "another Bot"} to release the workspace. Retry after its current run finishes.`;
  }
}

/** Waiting for a writer and reading a snapshot are different failures; neither may bypass the lock. */
export async function captureLockedReview(input: {
  local: LocalService;
  context: ToolRunContext;
  access: SourceAccess;
  scope: ChangesScope;
  kind: "turn" | "uncommitted";
  signal: AbortSignal;
  onWait?(holder?: WriteLockOwner): void;
}) {
  const { local, context, access, scope, kind, signal, onWait } = input;
  let stage: "lock" | "snapshot" = "lock";
  let holderName: string | undefined;
  try {
    return await local.writeLocks.withLock(
      { botId: context.botId, runId: context.runId },
      [access.root],
      access.signal,
      () => {
        stage = "snapshot";
        onWait?.();
        return captureReview(local, access, scope, kind, context.runId);
      },
      (holder) => {
        const name = new BotsRepo(local.deps.db).get(holder.botId)?.name ?? "";
        holderName = local.deps.redactor.redact(name).slice(0, 200);
        onWait?.(holder);
      },
    );
  } catch (error) {
    signal.throwIfAborted();
    if (access.signal.aborted || (error instanceof FolderLockError && error.code === "timeout"))
      throw new ReviewCaptureError(stage, holderName);
    throw error;
  } finally {
    onWait?.();
  }
}
