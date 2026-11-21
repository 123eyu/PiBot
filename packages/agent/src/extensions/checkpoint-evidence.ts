import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { officeRenderOutputPath, writeFileTools } from "@pibot/protocol-base";

type Message = SessionBeforeCompactEvent["preparation"]["messagesToSummarize"][number];
// Derived from the tool registrations, like the brain's delivery check.
const WRITE_TOOLS = writeFileTools();
const MAX_WRITES = 100;
const PATCH_HEADER = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gmu;

function convertTargets(args: Record<string, unknown>) {
  const output = typeof args.outputPath === "string" ? args.outputPath : undefined;
  if (output) return [output];
  if (typeof args.path !== "string") return [];
  // Without outputPath the converter derives the destination from the source name, mirroring
  // officeConvertOutputPath in the brain package (agent cannot depend on it).
  const stem = args.path.replace(/\.[^./\\]+$/, "");
  if (args.to === "csv") return [`${stem}-csv`];
  if (typeof args.to !== "string") return [`${stem}.md`];
  return [`${stem}.${args.to === "markdown" ? "md" : args.to}`];
}

function targets(name: string, args: Record<string, unknown>) {
  if (name === "office_convert") return convertTargets(args);
  if (name !== "apply_patch") return typeof args.path === "string" ? [args.path] : [];
  if (typeof args.patch !== "string") return [];
  return [...args.patch.matchAll(PATCH_HEADER)].map((m) => (m[1] ?? m[2] ?? "").trim());
}

/**
 * Paths whose write call has a recorded, non-error result. A model summary once claimed edits
 * that never happened; only this program-side list may support "modified" in a checkpoint.
 */
export function successfulWrites(messages: Message[]) {
  const calls = new Map<string, string[]>();
  const found = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant")
      for (const part of message.content) {
        if (part.type !== "toolCall") continue;
        const exportPath = officeRenderOutputPath(part.name, part.arguments);
        if (exportPath !== undefined) calls.set(part.id, [exportPath]);
        else if (WRITE_TOOLS.has(part.name)) calls.set(part.id, targets(part.name, part.arguments));
      }
    if (message.role !== "toolResult" || message.isError) continue;
    for (const path of calls.get(message.toolCallId) ?? []) {
      if (!path) continue;
      // Re-insert so the bounded list keeps the most recent writes.
      found.delete(path);
      found.add(path);
    }
  }
  return [...found].slice(-MAX_WRITES);
}

export function mergeWrites(previous: readonly string[], next: readonly string[]) {
  const merged = new Set(previous);
  for (const path of next) {
    merged.delete(path);
    merged.add(path);
  }
  return [...merged].slice(-MAX_WRITES);
}

export function writesSection(writes: readonly string[]) {
  return writes.length
    ? `[Successful file writes recorded by tool results / 工具结果确认成功的文件写入]\n${writes.join("\n")}`
    : "[Successful file writes recorded by tool results / 工具结果确认成功的文件写入]\nnone / 无";
}
