// External agents deliver changed output-folder files even when their reply omits the paths.
import { stat } from "node:fs/promises";
import { extname, relative, sep } from "node:path";
import {
  authorizationSnapshot,
  isOutputDeliverable,
  type LocalService,
  sendFiles,
  type ToolRunContext,
} from "@pibot/brain/kit";
import { AttachmentsRepo } from "@pibot/storage";

/** Kinds a person opens or previews, not source edits: a code change stays in the changes pane. */
const DELIVERABLE = new Set([
  ".html",
  ".htm",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".pdf",
  ".docx",
  ".pptx",
  ".xlsx",
  ".csv",
  ".md",
  ".mp3",
  ".mp4",
  ".wav",
]);

/**
 * An agent may not send what it made (and had no send_file before the bridge), so a page it made
 * only showed up in the changes pane and the person had to dig for it (maintainers 2026-11-15). The
 * deliverables it created this turn become file cards on its reply, through the same checked path
 * as send_file (inside the write roots, no links, unchanged while read, at most ten per reply).
 * Must run while the turn's changes are still being watched (before changes.turn.finish).
 */
export async function attachCreatedFiles(input: {
  local: LocalService;
  context: ToolRunContext;
  roots: readonly string[];
  cwd: string;
  startedAt: number;
  signal: AbortSignal;
  /** Already sent this turn with the bridge's send_file: not repeated as cards. */
  skip?: ReadonlySet<string>;
}): Promise<void> {
  const { local, context } = input;
  const touched = await local.changes.turn.touched(context.runId);
  const picked: string[] = [];
  const already =
    new AttachmentsRepo(local.deps.db).forMessages([context.messageId]).get(context.messageId)
      ?.length ?? 0;
  const available = Math.max(0, 10 - already);
  if (!available) return;
  for (const path of touched) {
    input.signal.throwIfAborted();
    if (input.roots.some((root) => relative(root, path).split(sep).includes(".cache"))) continue;
    const output = isOutputDeliverable(path, input.roots);
    if (
      (!output && !DELIVERABLE.has(extname(path).toLowerCase())) ||
      input.skip?.has(path) ||
      context.sentFilePaths?.has(path)
    )
      continue;
    const info = await stat(path).catch(() => undefined);
    // Outside the output folder, preserve the existing created-file-only behavior.
    // Linux may report no birth time; the change time is the closest stand-in there.
    const born = info ? info.birthtimeMs || info.ctimeMs : 0;
    if (!info?.isFile() || (!output && (!info.size || born < input.startedAt - 2_000))) continue;
    picked.push(path);
    if (picked.length >= available) break;
  }
  for (const path of picked)
    await sendFiles(
      local,
      context,
      {
        roots: [...input.roots],
        cwd: input.cwd,
        sendPaths: [path],
        authorization: authorizationSnapshot(local, context.botId, context),
      },
      input.signal,
      "external_agent",
    );
}
