import { lstat, opendir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { StoredToolCall } from "@pibot/storage";
import type { GroupService } from "./group-service.ts";
import { changedFiles } from "./group-verification-facts.ts";
import { groupWorkflowBriefPrompts } from "./prompts/group-workflow-brief.ts";

const FILES = 20;
const COMMANDS = 8;
const COMMAND_CHARS = 120;
const PATH_CHARS = 200;
const SCAN_MS = 3_000;
const SCAN_ENTRIES = 20_000;
/** Pi Bot's own state, git internals and installed packages are never someone's edit. */
const NOT_SCANNED = new Set([".pibot", ".git", "node_modules"]);
/** A command whose record ended this close to the run's end was cut off by the pause. */
const STOP_SLACK_MS = 10_000;
const LEVELS = [
  [FILES, COMMANDS, FILES],
  [10, 4, 10],
  [5, 2, 5],
  [2, 1, 2],
  [2, 1, 0],
  [2, 0, 0],
] as const;

type Paths = typeof import("node:path").posix;
interface Listed {
  items: string[];
  total: number;
}
/**
 * Maintainers 2026-11-21: what Pi Bot's own records say about the run the group's pause stopped,
 * for its rerun's brief (a new conversation that does not see that run). No model call.
 */
export interface ResumeSummary {
  files: Listed;
  /** Oldest first; `total` counts every command the run made. */
  commands: { items: { command: string; outcome: string; stopped: boolean }[]; total: number };
  /** Absent when the folder could not be compared cheaply and reliably. */
  others?: Listed;
}

export interface ResumeSummaryInput {
  runId: string;
  pausedAt?: string;
  continuedAt?: string;
  /** The step's working folder as the stopped run saw it (the group's, or the primary it mirrored). */
  cwd: string;
  isolated?: { root: string; primary: string };
  paths: Paths;
  /** The step works in the group's local folder, where the user may have edited during the pause. */
  scanShared: boolean;
}

const clean = (value: string, max: number) => {
  const text = [...value]
    .map((character) => (character.charCodeAt(0) < 32 ? " " : character))
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

function outcome(call: StoredToolCall, pausedAt: number | undefined, latest: boolean) {
  const text = groupWorkflowBriefPrompts.summary;
  const finished = call.finishedAt ? Date.parse(call.finishedAt) : undefined;
  const stopped =
    call.status === "running" ||
    call.status === "pending" ||
    (call.status === "aborted" &&
      (pausedAt !== undefined && finished !== undefined
        ? finished >= pausedAt - STOP_SLACK_MS
        : latest));
  if (stopped) return { outcome: text.stopped, stopped };
  if (call.status === "aborted") return { outcome: text.aborted, stopped };
  if (call.status === "blocked") return { outcome: text.blocked, stopped };
  if (call.exitCode !== null) return { outcome: text.exit({ code: call.exitCode }), stopped };
  return { outcome: call.status === "done" ? text.done : text.failed, stopped };
}

/**
 * Files under `root` modified after the stopped run ended and before the group continued. Bounded
 * by time and entries; when either bound is hit the answer is not reliable, so there is none.
 */
async function changedDuringPause(
  root: string,
  from: number,
  to: number,
  dataDir: string,
  outer: AbortSignal,
): Promise<Listed | undefined> {
  const signal = AbortSignal.any([outer, AbortSignal.timeout(SCAN_MS)]);
  const skipped = resolve(dataDir);
  const items: string[] = [];
  let total = 0;
  let seen = 0;
  const queue = [""];
  for (let index = 0; index < queue.length; index++) {
    const folder = queue[index] as string;
    const absolute = join(root, folder);
    if (resolve(absolute) === skipped) continue;
    let handle: Awaited<ReturnType<typeof opendir>>;
    try {
      handle = await opendir(absolute);
    } catch {
      // An unreadable subfolder is no one's edit we could see; an unreadable root means no answer.
      if (!folder) return undefined;
      continue;
    }
    // Leaving the loop early closes the directory handle.
    for await (const entry of handle) {
      if (signal.aborted || ++seen > SCAN_ENTRIES) return undefined;
      if (entry.isSymbolicLink()) continue;
      const relative = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!NOT_SCANNED.has(entry.name.toLowerCase())) queue.push(relative);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await lstat(join(root, relative)).catch(() => undefined);
      if (!info || info.mtimeMs <= from || info.mtimeMs > to) continue;
      total++;
      if (items.length < FILES) items.push(relative);
    }
  }
  return signal.aborted ? undefined : { items, total };
}

export async function resumeSummary(
  service: GroupService,
  input: ResumeSummaryInput,
  signal: AbortSignal,
): Promise<ResumeSummary> {
  const redact = (value: string) => service.deps.redactor.redact(value);
  const rows = service.deps.local.workspaceServices?.changes.turn.repo.summarize(input.runId) ?? [];
  const changed = [...new Set(changedFiles(rows, input.paths, input.cwd, input.isolated))];
  const files = {
    items: changed.slice(0, FILES).map((file) => clean(redact(file), PATH_CHARS)),
    total: changed.length,
  };
  const pausedAt = input.pausedAt ? Date.parse(input.pausedAt) : undefined;
  const recent = service.deps.local.tools.recentForRun(input.runId, "run_command", COMMANDS);
  const commands = {
    items: recent.calls
      .map((call, index) => ({
        command: clean(redact(call.summary.replace(/^run_command:\s*/u, "")), COMMAND_CHARS),
        ...outcome(call, pausedAt, index === 0),
      }))
      .reverse(),
    total: recent.total,
  };
  const continuedAt = input.continuedAt ? Date.parse(input.continuedAt) : undefined;
  const others =
    input.scanShared && pausedAt !== undefined && continuedAt !== undefined
      ? await changedDuringPause(input.cwd, pausedAt, continuedAt, service.deps.dataDir, signal)
      : undefined;
  signal.throwIfAborted();
  return {
    files,
    commands,
    ...(others
      ? {
          others: {
            items: others.items.map((file) => clean(redact(file), PATH_CHARS)),
            total: others.total,
          },
        }
      : {}),
  };
}

function render(
  summary: ResumeSummary,
  [files, commands, others]: readonly number[],
  lost: boolean,
) {
  const text = groupWorkflowBriefPrompts.summary;
  const parts: string[] = [];
  const list = (header: string, listed: Listed | undefined, cap = 0) => {
    if (!listed?.total || !cap) return;
    const shown = listed.items.slice(0, cap);
    parts.push(
      [
        header,
        ...shown.map((item) => `- ${item}`),
        ...(listed.total > shown.length
          ? [`- ${text.more({ count: listed.total - shown.length })}`]
          : []),
      ].join("\n"),
    );
  };
  list(lost ? text.filesLost : text.files, summary.files, files);
  if (summary.commands.total && commands) {
    const shown = summary.commands.items.slice(-commands);
    parts.push(
      [
        text.commands,
        ...(summary.commands.total > shown.length
          ? [text.earlier({ count: summary.commands.total - shown.length })]
          : []),
        ...shown.map((item) => `- ${item.command} → ${item.outcome}`),
      ].join("\n"),
    );
  }
  list(text.others, summary.others, others);
  return parts.join("\n\n");
}

/** The fullest form that fits `room` characters; lists shrink first, and none at all is fine. */
export function resumeSummaryText(summary: ResumeSummary, room: number, lost = false): string {
  for (const level of LEVELS) {
    const text = render(summary, level, lost);
    if (text.length <= room) return text;
  }
  return "";
}

export const resumeSummaryCounts = (summary: ResumeSummary) => ({
  files: summary.files.total,
  commands: summary.commands.total,
  stopped: summary.commands.items.filter((item) => item.stopped).length,
  others: summary.others?.total ?? null,
});
