import type { LocalService, ToolRunContext } from "@pibot/brain/kit";
import { ExecError } from "@pibot/execution";
import { ImageArtifactsRepo, imageArtifactFingerprint } from "@pibot/storage";
import { assertImageSaveOwner, type ImageWorkspaceTarget } from "./image-workspace-target.ts";

export function generatedImageSource(
  local: LocalService,
  context: ToolRunContext,
  target: ImageWorkspaceTarget,
  attachmentId: string,
) {
  assertImageSaveOwner(local, context);
  const artifacts = new ImageArtifactsRepo(local.deps.db);
  const record = artifacts.get(target.source.runId);
  if (!record || imageArtifactFingerprint(record.target) !== imageArtifactFingerprint(target))
    throw new ExecError("invalid_input");
  try {
    const result = artifacts.resolveSource(
      target.source.runId,
      {
        botId: context.botId,
        conversationId: context.conversationId as string,
        groupId: context.groupId,
        threadId: context.threadId,
        runId: context.runId,
      },
      [attachmentId],
    );
    const attachment = result.attachments[0];
    if (!attachment) throw new ExecError("invalid_input");
    return attachment;
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith("image_artifact_"))
      throw new ExecError(
        error.message === "image_artifact_not_visible" ? "outside_workplace" : "invalid_input",
      );
    throw error;
  }
}
