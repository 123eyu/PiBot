import { createHash } from "node:crypto";
import type {
  ContextEvent,
  ProjectedSessionEntry,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { buildSessionProjection } from "@earendil-works/pi-coding-agent/context-helpers";
import { z } from "zod";
import { contextBudget } from "../runtime/context-budget.ts";
import { historyTokens, messageTokens, textTokens } from "../runtime/context-estimate.ts";

type Message = ContextEvent["messages"][number];
const userSchema = z.object({ id: z.string(), text: z.string() });
export const checkpointDetails = z.object({
  kind: z.literal("pibot-checkpoint-v1"),
  users: z.array(userSchema).max(64),
  body: z.string(),
  writes: z.array(z.string()).max(100).optional(),
  workingSet: z.array(z.string().max(700)).max(40).optional(),
  commands: z
    .array(
      z.object({
        command: z.string().max(80),
        key: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        status: z.enum(["error", "finished", "timeout", "stopped", "running", "unknown"]),
        jobId: z.string().max(128).optional(),
        exitCode: z.number().nullable().optional(),
      }),
    )
    .max(40)
    .optional(),
});
export interface CheckpointPlan {
  firstKeptEntryId: string | null;
  prefixHash: string;
  prefixEntryCount: number;
  messages: Message[];
  previousSummary?: string;
  previousWrites?: string[];
  checkpointTokenLimit?: number;
  previousWorkingSet?: string[];
  previousCommands?: import("./checkpoint-locations.ts").CommandEvidence[];
  users: z.infer<typeof userSchema>[];
  tokensBefore: number;
  boundaries: number[];
  cuts: { end: number; firstKeptEntryId: string | null }[];
  sourceHash: string;
  sourceCount: number;
}
export function prefixHash(entries: ProjectedSessionEntry[]) {
  return createHash("sha256")
    .update(JSON.stringify(entries.map((e) => [e.sourceEntry.id, e.messages])))
    .digest("hex");
}
export function retainedUsers(
  entries: ProjectedSessionEntry[],
  window: number,
  redact: (text: string) => string,
) {
  const found = new Map<string, { id: string; text: string }>();
  for (const entry of entries) {
    if (entry.sourceEntry.type === "compaction") {
      const parsed = checkpointDetails.safeParse(entry.sourceEntry.details);
      if (parsed.success)
        for (const user of parsed.data.users)
          found.set(user.id, { ...user, text: redact(user.text) });
    }
    for (const message of entry.messages)
      if (message.role === "user") {
        const text = redact(
          typeof message.content === "string"
            ? message.content
            : message.content
                .filter((p) => p.type === "text")
                .map((p) => p.text)
                .join("\n"),
        );
        if (text.trim()) found.set(entry.sourceEntry.id, { id: entry.sourceEntry.id, text });
      }
  }
  let remaining = Math.min(6000, Math.floor(contextBudget(window).triggerTokens * 0.08));
  const ordered = [...found.values()];
  // Explicit prohibitions and corrections are easy to lose among many short "continue" inputs.
  // This only prioritizes verbatim storage; it never interprets text as a runtime permission.
  const critical = (text: string) =>
    /不要|不许|禁止|不得|必须|只在|仅在|不测试|不合并|改为|纠正|\b(?:do not|don't|never|must|only|instead)\b/iu.test(
      text,
    );
  const priority = [
    ordered.at(-1),
    ...ordered.filter((user) => critical(user.text)).reverse(),
    ordered[0],
    ...ordered.slice().reverse(),
  ];
  const selected = new Set<string>();
  for (const user of priority) {
    if (!user || selected.has(user.id)) continue;
    const size = textTokens(user.text);
    // Never cut a user prohibition in half. Omitted older requests remain represented by the body.
    if (selected.size >= 64 || size > remaining) continue;
    remaining -= size;
    selected.add(user.id);
  }
  return ordered.filter((user) => selected.has(user.id));
}
export function makeCheckpointPlan(
  branch: SessionEntry[],
  window: number,
  redact: (text: string) => string,
  all = false,
): CheckpointPlan | undefined {
  const projection = buildSessionProjection(branch);
  const entries = projection.entries;
  const keep = contextBudget(window).keepRecentTokens;
  let kept = 0;
  let cut = entries.length;
  // Never begin a retained suffix with a tool result. Its assistant and all sibling results stay.
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry) continue;
    kept += entry.messages.reduce((sum, m) => sum + messageTokens(m), 0);
    const first = entry.messages[0];
    if (
      first &&
      first.role !== "toolResult" &&
      first.role !== "system" &&
      first.role !== "compactionSummary"
    )
      cut = i;
    if (kept >= keep && cut < entries.length) break;
  }
  const tailTokens = historyTokens(entries.slice(cut).flatMap((entry) => entry.messages));
  const pending = new Set<string>();
  for (const message of projection.messages) {
    // Missing results from an interrupted older turn do not make the current tail unfinished.
    if (message.role === "user" || message.role === "assistant") pending.clear();
    if (message.role === "assistant")
      for (const part of message.content) if (part.type === "toolCall") pending.add(part.id);
    if (message.role === "toolResult") pending.delete(message.toolCallId);
  }
  // A single generated file/tool group can exceed the whole raw-tail allowance. Once all of
  // its results exist, checkpoint it too instead of retaining an inherently oversized suffix.
  if (
    !pending.size &&
    tailTokens >
      Math.min(contextBudget(window).inputLimit * 0.6, contextBudget(window).triggerTokens * 0.4)
  )
    cut = entries.length;
  if (all) cut = entries.length;
  const prefix = entries.slice(0, cut);
  const messages = prefix.flatMap((e) => e.messages).filter((m) => m.role !== "compactionSummary");
  if (!messages.some((m) => m.role === "assistant" || m.role === "toolResult")) return;
  const previous = prefix.find(
    (e) => e.sourceEntry.type === "compaction" && e.messages.length,
  )?.sourceEntry;
  const parsed =
    previous?.type === "compaction" ? checkpointDetails.safeParse(previous.details) : undefined;
  let end = 0;
  const cuts = prefix
    .map((entry, index) => {
      end += entry.messages.filter((message) => message.role !== "compactionSummary").length;
      return { end, firstKeptEntryId: entries[index + 1]?.sourceEntry.id ?? null };
    })
    .filter((cut) => cut.end > 0);
  return {
    cuts,
    boundaries: cuts.map((cut) => cut.end),
    sourceHash: createHash("sha256").update(JSON.stringify(branch)).digest("hex"),
    sourceCount: branch.length,
    firstKeptEntryId: entries[cut]?.sourceEntry.id ?? null,
    prefixHash: prefixHash(prefix),
    prefixEntryCount: prefix.length,
    messages,
    previousSummary: parsed?.success
      ? parsed.data.body
      : previous?.type === "compaction"
        ? previous.summary
        : undefined,
    checkpointTokenLimit: Math.floor(contextBudget(window).triggerTokens * 0.4),
    previousWrites: parsed?.success ? parsed.data.writes : undefined,
    previousWorkingSet: parsed?.success ? parsed.data.workingSet : undefined,
    previousCommands: parsed?.success ? parsed.data.commands : undefined,
    users: retainedUsers(entries, window, redact),
    tokensBefore: historyTokens(projection.messages),
  };
}
export function planStillApplies(plan: CheckpointPlan, branch: SessionEntry[]) {
  const entries = buildSessionProjection(branch).entries;
  const cut =
    plan.firstKeptEntryId === null
      ? plan.prefixEntryCount
      : entries.findIndex((e) => e.sourceEntry.id === plan.firstKeptEntryId);
  return cut >= 0 && prefixHash(entries.slice(0, cut)) === plan.prefixHash;
}

/** Newly appended messages after a whole-prefix candidate still remain verbatim. */
export function retainedBoundary(plan: CheckpointPlan, branch: SessionEntry[]) {
  if (plan.firstKeptEntryId !== null) return plan.firstKeptEntryId;
  return buildSessionProjection(branch).entries[plan.prefixEntryCount]?.sourceEntry.id ?? null;
}

/** Own appendCompaction entries extend the raw branch; they do not invalidate earlier source evidence. */
export function checkpointSourceApplies(plan: CheckpointPlan, branch: SessionEntry[]) {
  return (
    branch.length >= plan.sourceCount &&
    createHash("sha256")
      .update(JSON.stringify(branch.slice(0, plan.sourceCount)))
      .digest("hex") === plan.sourceHash
  );
}
export function checkpointBoundary(plan: CheckpointPlan, consumed: number, branch: SessionEntry[]) {
  const cut = plan.cuts.findLast((cut) => cut.end === consumed);
  if (!cut) throw new Error("Invalid checkpoint boundary");
  const sourceIds = new Set(branch.slice(0, plan.sourceCount).map((source) => source.id));
  return (
    cut.firstKeptEntryId ??
    buildSessionProjection(branch).entries.find(
      (entry) => !sourceIds.has(entry.sourceEntry.id) && entry.sourceEntry.type === "message",
    )?.sourceEntry.id ??
    null
  );
}
