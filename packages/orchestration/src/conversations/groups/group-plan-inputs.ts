import { basename, extname } from "node:path";
import { localWorkspaceFiles, type WorkspaceFileAccess } from "@pibot/brain/orchestration-kit";
import type { GroupExecutionPlan, GroupPlanCard } from "@pibot/protocol-base";
import { AttachmentsRepo, MessagesRepo } from "@pibot/storage";
import type { GroupService } from "./group-service.ts";

type PlanInput = GroupExecutionPlan["inputs"][number];

const INPUT_FOLDER = "inputs";
/** Attachment inputs carry their file name; a saved plan never keeps them. */
export const ATTACHMENT_INPUT = "附件 / attachment ";

function safeName(name: string) {
  const plain = basename(name.replace(/[\\/]/g, "_"))
    .replace(/[\p{Cc}]/gu, "")
    .trim()
    .slice(0, 120);
  return plain && plain !== "." && plain !== ".." ? plain : "attachment";
}

/**
 * Attachments on the request that produced a plan are plan-level inputs. The step
 * owners never see the coordinator's managed attachment store, so the program copies the bytes
 * (through the attachment service's owned-file read) into the plan's own work folder, where
 * steps read them with the ordinary workplace permissions and delivery checks count them as
 * sources. No new read channel: only the request's own attachments, bounded by the attachment
 * limits, written as new files that never overwrite anything.
 */
export async function planAttachmentInputs(
  service: GroupService,
  card: GroupPlanCard,
  folder: string,
  signal: AbortSignal,
  access: WorkspaceFileAccess = localWorkspaceFiles,
): Promise<PlanInput[]> {
  const origin = service.runs.get(card.originRunId);
  const group = service.groups.get(card.groupId);
  const request = origin?.userMessageId
    ? new MessagesRepo(service.deps.db).get(origin.userMessageId)
    : undefined;
  if (
    !group ||
    origin?.groupId !== card.groupId ||
    request?.role !== "user" ||
    request.conversationId !== group.conversationId
  )
    return [];
  const items = new AttachmentsRepo(service.deps.db).forMessages([request.id]).get(request.id);
  if (!items?.length) return [];
  const files = await service.deps.chat.attachments.forwardingInputs(
    items.map((item) => item.id),
    signal,
  );
  const paths = access.paths;
  const target = paths.join(folder, INPUT_FOLDER);
  const inputs: PlanInput[] = [];
  const used = new Set<string>();
  for (const file of files) {
    signal.throwIfAborted();
    const name = safeName(file.name);
    const extension = extname(name);
    const stem = name.slice(0, name.length - extension.length) || "attachment";
    for (let index = 1; ; index++) {
      const candidate = index === 1 ? name : `${stem}-${index}${extension}`;
      if (used.has(candidate)) continue;
      const path = paths.join(target, candidate);
      try {
        // `wx` never follows or replaces an existing entry; a collision takes the next suffix.
        await access.create(path, Buffer.from(file.data, "base64"), signal);
      } catch (error) {
        if (
          ["EEXIST", "file_conflict"].includes(String((error as NodeJS.ErrnoException).code)) &&
          index < 50
        )
          continue;
        throw error;
      }
      used.add(candidate);
      inputs.push({
        name: `${ATTACHMENT_INPUT}${candidate}`.slice(0, 200),
        kind: "file",
        value: path,
      });
      break;
    }
  }
  return inputs;
}
