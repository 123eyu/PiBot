import { createHash } from "node:crypto";
import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { textTokens } from "../runtime/context-estimate.ts";

type Message = SessionBeforeCompactEvent["preparation"]["messagesToSummarize"][number];
export interface CommandEvidence {
  command: string;
  key?: string;
  jobId?: string;
  status: "error" | "finished" | "timeout" | "stopped" | "running" | "unknown";
  exitCode?: number | null;
}

/** Locations and completion metadata only; never copy command output into this evidence. */
export function checkpointLocations(
  messages: Message[],
  previous: readonly CommandEvidence[] = [],
) {
  const workingSet = new Set<string>();
  const commands = new Map(previous.map((item) => [item.key ?? item.command, item]));
  const jobs = new Map(
    previous.flatMap((item) =>
      item.jobId ? [[item.jobId, item.key ?? item.command] as const] : [],
    ),
  );
  const pending = new Map<string, { command?: string; key?: string; jobId?: string }>();
  const latestCalls = new Map<string, string>();
  const remember = (key: string, evidence: CommandEvidence) => {
    commands.delete(key);
    commands.set(key, evidence);
    if (commands.size > 40) commands.delete(commands.keys().next().value as string);
  };
  for (const message of messages) {
    if (message.role === "assistant")
      for (const part of message.content) {
        if (part.type !== "toolCall") continue;
        const args = part.arguments;
        if (
          ["read_file", "search_text", "code_navigate"].includes(part.name) &&
          typeof args.path === "string"
        ) {
          const offset = typeof args.offset === "number" ? args.offset : 0;
          const line =
            part.name === "read_file"
              ? offset + 1
              : typeof args.startLine === "number"
                ? args.startLine
                : args.line;
          const end =
            part.name === "read_file"
              ? offset + (typeof args.limit === "number" ? args.limit : 2000)
              : typeof args.endLine === "number"
                ? args.endLine
                : undefined;
          const symbol =
            typeof args.query === "string" && /^[\p{L}\p{N}_$.-]{1,100}$/u.test(args.query)
              ? args.query
              : undefined;
          const location = `${args.path.slice(0, 500)}${typeof line === "number" ? `:${line}${end === undefined ? "" : `-${end}`}` : ""}${symbol ? ` (${symbol})` : ""}`;
          workingSet.delete(location);
          workingSet.add(location);
          if (workingSet.size > 40) workingSet.delete(workingSet.values().next().value as string);
        }
        if (part.name === "run_command" && typeof args.command === "string") {
          const key = createHash("sha256").update(args.command).digest("hex");
          const priorJob = commands.get(key)?.jobId;
          // Declaration order defines recency even when parallel results arrive in reverse.
          if (priorJob) jobs.delete(priorJob);
          latestCalls.set(key, part.id);
          const command = args.command.slice(0, 80);
          remember(key, { command, key, status: "unknown" });
          pending.set(part.id, {
            command,
            key,
          });
        }
        if (part.name === "background_command" && typeof args.id === "string")
          pending.set(part.id, { jobId: args.id });
      }
    if (message.role !== "toolResult") continue;
    const call = pending.get(message.toolCallId);
    if (!call) continue;
    pending.delete(message.toolCallId);
    const details = message.details as Record<string, unknown> | undefined;
    if (call.key && latestCalls.get(call.key) !== message.toolCallId) continue;
    if (
      call.jobId &&
      typeof details?.backgroundJobId === "string" &&
      details.backgroundJobId !== call.jobId
    )
      continue;
    const jobId =
      typeof details?.backgroundJobId === "string" ? details.backgroundJobId : call.jobId;
    const key = call.key ?? (jobId ? jobs.get(jobId) : undefined);
    if (!key) continue;
    const previous = commands.get(key);
    // A poll or wait only updates the command attempt that actually owns this job.
    if (!call.key && previous?.jobId !== jobId) continue;
    const command = call.command ?? previous?.command;
    if (command === undefined) continue;
    if (jobId) jobs.set(jobId, key);
    const exitCode =
      typeof details?.exitCode === "number" || details?.exitCode === null
        ? details.exitCode
        : undefined;
    // A tool can return successfully while its process is still running; never infer completion.
    const status: CommandEvidence["status"] =
      details?.backgroundWaiting === true || details?.backgroundStatus === "running"
        ? "running"
        : details?.timedOut === true
          ? "timeout"
          : details?.stopped === true || details?.backgroundStatus === "stopped"
            ? "stopped"
            : details?.backgroundStatus === "failed" ||
                message.isError ||
                (typeof exitCode === "number" && exitCode !== 0)
              ? "error"
              : typeof exitCode === "number"
                ? "finished"
                : "unknown";
    remember(key, {
      command,
      key,
      status,
      ...(jobId ? { jobId } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
    });
  }
  return { workingSet: [...workingSet], commands: [...commands.values()] };
}

export function locationsSection(
  workingSet: readonly string[],
  commands: readonly CommandEvidence[],
) {
  return `\n\n[Working set: locations only / 工作集：仅位置；按需读片段，避免整文件重读]\n${workingSet.join("\n") || "none / 无"}\n\n[Recorded command results / 程序记录的命令结果；不证明当前代码已验证]\n${commands.map(({ command, status, exitCode }) => JSON.stringify({ command, status, exitCode })).join("\n") || "none / 无"}`;
}

export function boundedLocations(
  workingSet: string[],
  commands: CommandEvidence[],
  budget: number,
) {
  const keptPaths: string[] = [],
    keptCommands: CommandEvidence[] = [];
  const limit = Math.max(0, Math.min(1024, budget));
  const render = () => locationsSection(keptPaths, keptCommands);
  // Alternate recent locations and command receipts so a long working set cannot crowd out checks.
  for (let index = 1; index <= Math.max(workingSet.length, commands.length); index++) {
    const path = workingSet.at(-index);
    if (path !== undefined) {
      keptPaths.unshift(path);
      if (textTokens(render()) > limit) keptPaths.shift();
    }
    const command = commands.at(-index);
    if (command !== undefined) {
      keptCommands.unshift(command);
      if (textTokens(render()) > limit) keptCommands.shift();
    }
  }
  const omitted = {
    workingSet: workingSet.length - keptPaths.length,
    commands: commands.length - keptCommands.length,
  };
  const receipt = `\n[Evidence boundary / 证据边界: omitted locations=${omitted.workingSet}, commands=${omitted.commands}]`;
  let section = render();
  while ((keptPaths.length || keptCommands.length) && textTokens(section + receipt) > limit) {
    if (keptPaths.length > keptCommands.length) {
      keptPaths.shift();
      omitted.workingSet++;
    } else {
      keptCommands.shift();
      omitted.commands++;
    }
    section = render();
  }
  const boundary = `\n[Evidence boundary / 证据边界: omitted locations=${omitted.workingSet}, commands=${omitted.commands}]`;
  section = textTokens(section + boundary) <= limit ? section + boundary : "";
  return { workingSet: keptPaths, commands: keptCommands, omitted, section };
}
