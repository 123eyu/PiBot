import { extname } from "node:path";
import type { LocalToolCall } from "@pibot/agent";
import { parsePatch } from "@pibot/execution";
import type { ToolStatus } from "@pibot/protocol-base";
import { DEFAULT_CODE_EXTENSIONS } from "../checks/auto-check-files.ts";
export interface WorkQualityFacts {
  completed: number;
  failed: number;
  blocked: number;
  writes: number;
  visualWrites: number;
  engineeringWrites: number;
  commands: number;
  sources: number;
  reads: number;
  browser: number;
  observations: number;
  deliveries: number;
}
export function workQualityFacts(): WorkQualityFacts {
  return {
    completed: 0,
    failed: 0,
    blocked: 0,
    writes: 0,
    visualWrites: 0,
    engineeringWrites: 0,
    commands: 0,
    sources: 0,
    reads: 0,
    browser: 0,
    observations: 0,
    deliveries: 0,
  };
}
const VISUAL_FILES = new Set([
  ".html",
  ".htm",
  ".svg",
  ".css",
  ".scss",
  ".jsx",
  ".tsx",
  ".vue",
  ".svelte",
]);
const CODE_FILES = new Set(DEFAULT_CODE_EXTENSIONS);
/** Count actual terminal receipts, never model prose, raw outputs, paths or customer content. */
export function observeWorkQuality(
  facts: WorkQualityFacts,
  call: LocalToolCall,
  status: ToolStatus,
  exitCode?: number,
) {
  if (status === "blocked" || status === "aborted") {
    facts.blocked++;
    return;
  }
  if (status === "error" || (exitCode !== undefined && exitCode !== 0)) {
    facts.failed++;
    return;
  }
  if (status !== "done") return;
  facts.completed++;
  const tool = call.tool;
  if (tool === "apply_patch" && typeof call.input.patch === "string") {
    for (const file of parsePatch(call.input.patch)) {
      facts.writes++;
      const extension = extname(file.path).toLowerCase();
      if (VISUAL_FILES.has(extension)) facts.visualWrites++;
      else if (CODE_FILES.has(extension)) facts.engineeringWrites++;
    }
  }
  if (tool === "write_file" || tool === "edit_file") {
    facts.writes++;
    const input = call.input as { path?: unknown } | undefined;
    if (typeof input?.path === "string") {
      const extension = extname(input.path).toLowerCase();
      if (VISUAL_FILES.has(extension)) facts.visualWrites++;
      else if (CODE_FILES.has(extension)) facts.engineeringWrites++;
    }
  }
  if (tool === "run_command") facts.commands++;
  if (tool === "web_fetch" || tool === "web_search") facts.sources++;
  if (["read_file", "search_text", "find_files", "list_dir", "list_directory"].includes(tool))
    facts.reads++;
  if (tool.startsWith("browser_")) facts.browser++;
  if (
    [
      "browser_snapshot",
      "browser_screenshot",
      "browser_diagnostics",
      "screenshot",
      "ui_tree",
    ].includes(tool)
  )
    facts.observations++;
  if (tool === "send_file") facts.deliveries++;
}

/** Receipts describe tool activity only; activity never starts another model request. */
export function workQualityReceipt(facts: WorkQualityFacts | undefined) {
  if (!facts || !(facts.completed || facts.failed || facts.blocked)) return undefined;
  return { version: 2, reviewPasses: 0, observed: { ...facts } };
}
