import type { Usage } from "@earendil-works/pi-ai";
import { textTokens } from "../runtime/context-estimate.ts";
import { mergeWrites, successfulWrites, writesSection } from "./checkpoint-evidence.ts";
import {
  boundedLocations,
  type CommandEvidence,
  checkpointLocations,
} from "./checkpoint-locations.ts";
import {
  type CheckpointPlan,
  checkpointSourceApplies,
  planStillApplies,
} from "./checkpoint-plan.ts";
import type { SummaryInput } from "./checkpoint-summary.ts";

export interface CheckpointResult {
  summary: string;
  usage?: Usage;
  details: {
    kind: "pibot-checkpoint-v1";
    body: string;
    users: { id: string; text: string }[];
    writes: string[];
    workingSet?: string[];
    commands?: CommandEvidence[];
    evidenceOmitted?: { workingSet: number; commands: number };
    mechanical?: boolean;
  };
  consumedMessages: number;
  complete: boolean;
}

// A resumed model once announced completion from a checkpoint that claimed unmade edits.
const RESUME_NOTE =
  "[Resume note / 续接提示] This checkpoint is a summary, not proof. Before continuing or reporting completion, check the actual state (e.g. inspect the changes or re-read the files); never declare the task done from this summary alone. / 这是摘要，不是证据。继续或宣布完成前，先核对实际状态（例如查看改动、重新读取文件），不要仅凭摘要宣布完成。";

export function checkpointResult(
  body: string,
  input: SummaryInput,
  consumedMessages: number,
  usage?: Usage,
  mechanical = false,
): CheckpointResult {
  const users = input.users;
  const writes = mergeWrites(
    input.previousWrites ?? [],
    successfulWrites(input.messages.slice(0, consumedMessages)),
  );
  const locations = checkpointLocations(
    input.messages.slice(0, consumedMessages),
    input.previousCommands,
  );
  const pathSet = new Set(input.previousWorkingSet ?? []);
  for (const path of locations.workingSet) {
    pathSet.delete(path);
    pathSet.add(path);
  }
  const workingSet = [...pathSet].slice(-40);
  const commandMap = new Map(
    (input.previousCommands ?? []).map((item) => [item.key ?? item.command, item]),
  );
  for (const item of locations.commands) {
    commandMap.delete(item.key ?? item.command);
    commandMap.set(item.key ?? item.command, item);
  }
  const commands = [...commandMap.values()].slice(-40);
  const anchors = users.length
    ? `\n\n[User text retained verbatim / 保留的用户原文，按时间排列；后续原文纠正优先]\n${users.map((user) => JSON.stringify(user.text)).join("\n")}`
    : "";
  const base = `${body}\n\n${writesSection(writes)}${anchors}\n\n${RESUME_NOTE}`;
  const evidence = boundedLocations(
    workingSet,
    commands,
    Math.max(0, (input.checkpointTokenLimit ?? 4096) - textTokens(base)),
  );
  return {
    summary: `${base}${evidence.section}`,
    usage,
    details: {
      kind: "pibot-checkpoint-v1",
      body,
      users,
      writes,
      workingSet: evidence.workingSet,
      commands: evidence.commands,
      evidenceOmitted: evidence.omitted,
      ...(mechanical ? { mechanical } : {}),
    },
    consumedMessages,
    complete: consumedMessages === input.messages.length,
  };
}

/** A bounded process-owned cache, never an authority receipt. Keys include session/workspace/prefix. */
export class CheckpointCache {
  private readonly entries = new Map<string, CheckpointResult>();
  private bytes = 0;
  private readonly scales = new Map<string, number>();
  scale(identity: string, value?: number) {
    if (value !== undefined) {
      this.scales.delete(identity);
      this.scales.set(identity, value);
      while (this.scales.size > 32) {
        const first = this.scales.keys().next().value;
        if (first !== undefined) this.scales.delete(first);
      }
    }
    return this.scales.get(identity);
  }
  private readonly candidates = new Map<
    string,
    { identity: string; plan: CheckpointPlan; result: CheckpointResult }
  >();
  candidate(identity: string, plan: CheckpointPlan, result: CheckpointResult) {
    const key = `${identity}:${plan.prefixHash}`;
    if (plan.cuts.length > 10000 || Buffer.byteLength(JSON.stringify(result)) > 128 * 1024) return;
    this.candidates.delete(key);
    this.candidates.set(key, {
      identity,
      plan: { ...plan, messages: [] },
      result: structuredClone(result),
    });
    while (this.candidates.size > 8) {
      const first = this.candidates.keys().next().value;
      if (first !== undefined) this.candidates.delete(first);
    }
  }
  find(identity: string, branch: Parameters<typeof planStillApplies>[1]) {
    for (const candidate of [...this.candidates.values()].reverse())
      if (
        candidate.identity === identity &&
        checkpointSourceApplies(candidate.plan, branch) &&
        planStillApplies(candidate.plan, branch)
      )
        return {
          ...structuredClone(candidate),
          result: { ...structuredClone(candidate.result), usage: undefined },
        };
    return undefined;
  }
  get(key: string) {
    const result = this.entries.get(key);
    return result ? structuredClone(result) : undefined;
  }
  save(key: string, result: CheckpointResult) {
    const size = Buffer.byteLength(JSON.stringify(result));
    if (size > 256 * 1024) return;
    const old = this.entries.get(key);
    if (old) this.bytes -= Buffer.byteLength(JSON.stringify(old));
    this.entries.delete(key);
    this.entries.set(key, structuredClone(result));
    this.bytes += size;
    while (this.entries.size > 32 || this.bytes > 2 * 1024 * 1024) {
      const first = this.entries.keys().next().value;
      if (first === undefined) break;
      this.bytes -= Buffer.byteLength(JSON.stringify(this.entries.get(first)));
      this.entries.delete(first);
    }
  }
}

export function redactCheckpoint(
  result: CheckpointResult,
  redact: (text: string) => string,
): CheckpointResult {
  return {
    ...result,
    summary: redact(result.summary),
    details: {
      ...result.details,
      body: redact(result.details.body),
      users: result.details.users.map((user) => ({ ...user, text: redact(user.text) })),
      writes: result.details.writes.map(redact),
      workingSet: result.details.workingSet?.map(redact),
      commands: result.details.commands?.map((item) => ({
        ...item,
        command: redact(item.command),
      })),
    },
  };
}
export function checkpointUsageDelta(total: Usage | undefined, previous: Usage | undefined) {
  if (!total || !previous) return total;
  const delta = structuredClone(total);
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
    delta[key] = Math.max(0, total[key] - previous[key]);
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
    delta.cost[key] = Math.max(0, total.cost[key] - previous.cost[key]);
  return delta;
}
