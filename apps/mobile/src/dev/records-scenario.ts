import { collapseRepeats } from "@pibot/client-core";
import { createTranslator } from "@pibot/i18n";
import {
  type AuditEntry,
  type BackgroundCommandRecord,
  type Bot,
  type MethodParams,
  type MethodResults,
  type Methods,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";
import type { Caller } from "../features/chat/controls/scope.ts";
import { logKey, moreRunLog, openRunLog, prefetchFailedLogs } from "../features/records/log.ts";
import {
  type ChatRun,
  chatRow,
  RECORD_WINDOW_MS,
  type RecordRow,
} from "../features/records/model.ts";
import { type PresentContext, presentRecord } from "../features/records/present.ts";
import { FULL_SYNC, readRecords, syncRecords, writeSource } from "../features/records/sync.ts";
import { resolveRecordTarget } from "../features/records/target.ts";
import { formatText, zh } from "../i18n/messages.ts";
import { memoryBlobFiles } from "../storage/file-cache.ts";
import { MobileStorage } from "../storage/state.ts";
import type { LocalData, SecretData } from "../storage/types.ts";

type RoutineRun = MethodResults["routines.history"][number];
/** The desktop's real phone gateway in front of a scripted kernel (packages/remote/dev). */
export interface RecordsHarness {
  phone: {
    call(
      method: string,
      params: unknown,
      options?: { signal?: AbortSignal; timeoutMs?: number },
    ): Promise<unknown>;
  };
  frames: number[];
  dispatched: { method: string; params: unknown }[];
  audits: { method: string; outcome: string }[];
  stop(): Promise<void>;
}
export type StartHarness = (
  dispatch: (method: string, params: unknown) => Promise<unknown>,
) => RecordsHarness;

const DAY = 86_400_000;
const id = (): string => crypto.randomUUID();
function memoryStorage() {
  const values = new Map<string, unknown>(),
    secrets = new Map<string, string>();
  const data: LocalData = {
    get: async (key) => structuredClone(values.get(key)),
    put: async (key, value) => void values.set(key, structuredClone(value)),
    removePrefix: async (prefix) => {
      for (const key of values.keys()) if (key.startsWith(prefix)) values.delete(key);
    },
    close: async () => undefined,
  };
  const secure: SecretData = {
    get: async (key) => secrets.get(key) ?? null,
    set: async (key, value) => void secrets.set(key, value),
    remove: async (key) => void secrets.delete(key),
  };
  return new MobileStorage(data, secure, memoryBlobFiles());
}
/** Newest first, like the brain's pages; `before` is the previous page's last ID. */
function page<T extends { id: string }>(
  rows: T[],
  params: { before?: string; limit?: number },
  max: number,
) {
  const start = params.before ? rows.findIndex((row) => row.id === params.before) + 1 : 0;
  return rows.slice(start, start + Math.min(params.limit ?? max, max));
}

/**
 * Run records through the real phone gateway: the read methods it allows, the 3-day window on the
 * computer's clock, capped pages and log pages that fit a phone frame, refusals of everything
 * that acts on the computer; then the phone's copy (sync, merge, prune), collapsed repeats, the
 * log cache, the jump-to-chat target and unpair. No network, no native modules.
 */
export async function runRecordsScenario(start: StartHarness) {
  let checks = 0;
  const check = (value: unknown, label: string) => {
    if (!value) throw new Error(`records_check_${label}`);
    checks++;
  };
  const now = Date.now();
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const botId = id(),
    topicId = id(),
    failedRun = id(),
    logRun = id();
  // 260 audit facts over 5 days, a run of identical failures among the newest.
  const audit: AuditEntry[] = Array.from({ length: 260 }, (_, index) => {
    const failing = index >= 2 && index < 7;
    return {
      id: id(),
      // Off the half hour, so no fact sits exactly on the 3-day boundary.
      at: ago(index * 30 * 60_000 + 7 * 60_000),
      botId,
      kind: index === 1 ? "connector.changed" : "exec.finished",
      summary: index === 1 ? "connected" : "ran",
      detail: failing
        ? { command: "npm test", toolName: "run_command", exitCode: 1, toolCallId: `t${index}` }
        : {
            command: `echo ${index}`,
            toolName: "run_command",
            exitCode: 0,
            toolCallId: `t${index}`,
          },
      runId: failing ? failedRun : id(),
    };
  });
  const routine = (age: number, status: RoutineRun["status"]): RoutineRun => ({
    id: id(),
    routineId: id(),
    botId,
    triggerId: null,
    reason: "cron",
    scheduledFor: ago(age),
    queuedAt: null,
    queueExpiresAt: null,
    maxDurationMin: 30,
    startedAt: ago(age),
    finishedAt: ago(age - 60_000),
    status,
    runId: id(),
    conversationId: topicId,
    triggerMessageId: id(),
    errorCode: status === "failed" ? "tool_failed" : null,
    summary: "Checked the inbox",
    allowedOps: [],
    activeMs: 60_000,
    waitingMs: 0,
    activeSince: null,
    waitingSince: null,
    waitExpiresAt: null,
    createdAt: ago(age),
    taskName: "Morning check",
    taskDeleted: false,
    bot: { name: "Ada", avatarShape: "circle", avatarColor: "blue", avatarEyes: "sleepy" },
  });
  const routines = [routine(DAY, "done"), routine(2 * DAY, "failed"), routine(5 * DAY, "done")];
  const chatRun = (
    age: number,
    status: ChatRun["status"],
    extra: Partial<ChatRun> = {},
  ): ChatRun => ({
    id: id(),
    botId,
    conversationId: topicId,
    groupId: null,
    kind: "chat",
    status,
    messageId: id(),
    userMessageId: id(),
    taskId: null,
    cycleId: null,
    automatic: false,
    parentRunId: null,
    afterRunId: null,
    stopReason: null,
    errorCode: status === "error" ? "model_error" : null,
    createdAt: ago(age),
    startedAt: ago(age),
    finishedAt: status === "running" ? null : ago(age - 30_000),
    ...extra,
  });
  const chats = [
    chatRun(60_000, "done", { id: logRun }),
    chatRun(DAY, "error"),
    chatRun(6 * DAY, "running"),
    chatRun(8 * DAY, "done"),
  ];
  const command = (
    status: BackgroundCommandRecord["status"],
    started: number,
    ended?: number,
  ): BackgroundCommandRecord => ({
    id: id(),
    botId,
    conversationId: topicId,
    groupId: null,
    runId: id(),
    toolCallId: "bg",
    command: "npm run dev",
    status,
    stopReason: status === "stopped" ? "user" : null,
    exitCode: status === "exited" ? 0 : null,
    ports: [],
    portsVisible: true,
    startedAt: ago(started),
    endedAt: ended === undefined ? null : ago(ended),
    place: { kind: "topic", title: "Website", groupName: null },
  });
  const commands = [
    command("running", 6 * DAY),
    command("stopped", 2 * DAY, DAY),
    command("exited", 6 * DAY, 5 * DAY),
  ];
  // ANSI colour codes escape to six bytes each in JSON; `worst` is nothing but such bytes.
  const worstRun = id();
  const line = (n: number) => `\u001b[31m${"\u001b[0m".repeat(20)} line ${n}\n`;
  const log = Array.from({ length: 6000 }, (_, n) => line(n)).join("");
  const logs = new Map([
    [logRun, log],
    [failedRun, "npm test\nFAIL src/app.test.ts\n"],
    [worstRun, "\u0001".repeat(300 * 1024)],
  ]);
  const dispatch = async (method: string, params: unknown): Promise<unknown> => {
    const input = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "audit.list":
        // The kernel applies no time bound here; the gateway must.
        return page(audit, input, 200);
      case "routines.history":
        return page(
          routines.filter((run) => !input.from || run.createdAt >= (input.from as string)),
          input,
          200,
        );
      case "chat.runs":
        return page(
          chats.filter((run) =>
            input.groupId ? run.groupId === input.groupId : run.botId === input.botId,
          ),
          input,
          200,
        );
      case "backgroundCommands.page":
        return commands.filter((row) => (input.state === "running") === (row.status === "running"));
      case "runs.readLog": {
        const text = logs.get(input.runId as string);
        if (text === undefined) throw new RpcError(RpcErrorCodes.runLogMissing, "run_log_missing");
        const offset = (input.offset as number | undefined) ?? 0;
        const end = Math.min(
          text.length,
          offset + ((input.limit as number | undefined) ?? 256 * 1024),
        );
        return {
          text: text.slice(offset, end),
          offset,
          nextOffset: end < text.length ? end : null,
          totalBytes: text.length,
          truncated: false,
        };
      }
      default:
        throw new RpcError(RpcErrorCodes.methodNotFound, "unexpected");
    }
  };
  const harness = start(dispatch);
  const c: Caller = {
    call: (<K extends keyof typeof Methods>(
      method: K,
      params: MethodParams[K],
      signal?: AbortSignal,
      timeoutMs?: number,
    ) => harness.phone.call(method, params, { signal, timeoutMs })) as Caller["call"],
  };
  const refused = async (method: string, params: unknown) => {
    try {
      await harness.phone.call(method, params);
      return "accepted";
    } catch (error) {
      return error instanceof RpcError ? error.message : String(error);
    }
  };
  const storage = memoryStorage();
  const computerId = id();
  const signal = new AbortController().signal;
  const cutoff = now - RECORD_WINDOW_MS;
  try {
    // 1. The gateway: allowed reads, clamps, refusals.
    const wide = (await c.call("audit.list", { limit: 200 })) as AuditEntry[];
    const sent = harness.dispatched.at(-1)?.params as { limit: number };
    check(sent.limit === 100 && wide.length === 100, "audit_page_capped");
    let before: string | undefined;
    let total = 0;
    for (;;) {
      const rows = await c.call("audit.list", { limit: 100, ...(before ? { before } : {}) });
      total += rows.length;
      check(
        rows.every((row) => Date.parse(row.at) >= cutoff - 1000),
        "audit_window",
      );
      if (rows.length < 100) break;
      before = rows.at(-1)?.id;
    }
    const inWindow = audit.filter((row) => Date.parse(row.at) >= cutoff).length;
    check(total === inWindow && total < audit.length, "audit_paged_to_window");
    const history = await c.call("routines.history", { from: ago(10 * DAY), limit: 200 });
    const historyParams = harness.dispatched.at(-1)?.params as { from: string; limit: number };
    check(
      Date.parse(historyParams.from) >= cutoff - 1000 && historyParams.limit === 100,
      "history_from_clamped",
    );
    check(history.length === 2, "history_window");
    const runs = await c.call("chat.runs", { botId, limit: 200 });
    check(
      runs.some((run) => run.status === "running") &&
        !runs.some((run) => Date.parse(run.createdAt) < now - 7 * DAY),
      "runs_window_keeps_active",
    );
    const ended = await c.call("backgroundCommands.page", { state: "ended", limit: 100 });
    const running = await c.call("backgroundCommands.page", { state: "running" });
    check(ended.length === 1 && running.length === 1, "commands_window_keeps_running");
    const frameLimit = 900_000;
    const firstLog = await c.call("runs.readLog", { runId: logRun });
    const logParams = harness.dispatched.at(-1)?.params as { limit: number };
    check(logParams.limit === 128 * 1024 && firstLog.nextOffset !== null, "log_page_capped");
    await c.call("runs.readLog", { runId: worstRun, limit: 256 * 1024 });
    const worstFrame = harness.frames.at(-1) ?? 0;
    check(worstFrame > 700_000 && worstFrame <= frameLimit, "log_worst_case_fits");
    const stopId = { botId, id: commands[0]?.id };
    const refusals = {
      "backgroundCommands.stop": await refused("backgroundCommands.stop", stopId),
      "backgroundCommands.open": await refused("backgroundCommands.open", stopId),
      "runs.revealLog": await refused("runs.revealLog", { runId: logRun }),
      "runs.openLog": await refused("runs.openLog", { runId: logRun }),
    };
    check(
      Object.values(refusals).every((value) => value === "remote_method_unavailable") &&
        !harness.dispatched.some((call) => call.method in refusals),
      "acts_refused",
    );
    check(!harness.audits.some((row) => row.method === "audit.list"), "reads_not_audited");
    check(
      harness.audits.filter((row) => row.outcome === "refused").length === 4,
      "refusals_audited",
    );

    // 2. The phone's copy: a full pass, then an incremental one.
    const conversations = [
      {
        key: `dm:${botId}`,
        kind: "bot" as const,
        id: botId,
        name: "Ada",
        looks: [],
        updatedAt: ago(0),
      },
    ];
    await syncRecords(c, storage, computerId, conversations, FULL_SYNC, signal);
    const copy = await readRecords(storage, computerId);
    const counts = {
      audit: copy.rows.filter((row) => row.type === "audit").length,
      routine: copy.rows.filter((row) => row.type === "routine").length,
      chat: copy.rows.filter((row) => row.type === "chat").length,
      command: copy.rows.filter((row) => row.type === "command").length,
    };
    check(
      counts.audit === inWindow &&
        counts.routine === 2 &&
        counts.chat === 3 &&
        counts.command === 2,
      "copy_counts",
    );
    const fresh = Array.from(
      { length: 3 },
      (_, n): AuditEntry => ({
        ...(audit[0] as AuditEntry),
        id: id(),
        at: new Date(now + (n + 1) * 1000).toISOString(),
      }),
    );
    audit.unshift(...fresh.reverse());
    const callsBefore = harness.dispatched.length;
    await syncRecords(c, storage, computerId, conversations, { audit: true }, signal);
    const incremental = await readRecords(storage, computerId);
    check(
      harness.dispatched.length - callsBefore === 1 &&
        incremental.rows.filter((row) => row.type === "audit").length === inWindow + 3,
      "audit_incremental_one_page",
    );
    // A row that left the window is dropped from storage on the next write.
    await writeSource(
      storage,
      computerId,
      "chats",
      [chatRun(4 * DAY, "done"), ...chats.slice(0, 2)],
      false,
    );
    check(
      (await readRecords(storage, computerId)).rows.filter((row) => row.type === "chat").length ===
        2,
      "pruned",
    );

    // 3. Collapsed repeats (shared client-core helper) on the phone's phrasing.
    const shared = createTranslator("zh");
    const bot = {
      id: botId,
      name: "Ada",
      avatarShape: "circle",
      avatarColor: "blue",
      avatarEyes: "sleepy",
    } as Bot;
    const context: PresentContext = {
      t: (key, vars) => formatText(zh[key], vars),
      shared,
      status: (status) => status,
      bots: new Map([[botId, bot]]),
      groupName: () => undefined,
    };
    const items = incremental.rows.map((row) => ({ row, view: presentRecord(row, context) }));
    const groups = collapseRepeats(
      items,
      (item) => item.row.id,
      (item) => item.view.repeatKey,
    );
    const repeated = groups.filter((group) => group.rows.length > 1);
    const failures = repeated.find((group) => group.rows[0]?.view.outcome.tone === "danger");
    check(failures?.rows.length === 5, "repeats_collapsed");

    // 4. Logs: paged under the frame cap, cached, failed runs prefetched, read offline.
    const files = storage.files;
    const opened = await openRunLog(c, files, { computerId, runId: logRun, online: true });
    let current = opened.log;
    while (current.nextOffset !== null)
      current = await moreRunLog(c, files, { computerId, runId: logRun, log: current });
    check(current.pages.join("") === log && current.pages.length > 1, "log_complete");
    check(Math.max(...harness.frames) <= frameLimit, "frames_fit");
    const offline = await openRunLog(c, files, { computerId, runId: logRun, online: false });
    check(offline.stale && offline.log.pages.length === current.pages.length, "log_offline");
    const danger = (entry: AuditEntry) => entry.detail.exitCode === 1;
    const prefetched = await prefetchFailedLogs(
      c,
      files,
      computerId,
      incremental.rows,
      danger,
      signal,
    );
    check(
      prefetched >= 1 && !!(await files.peek(computerId, logKey(failedRun))),
      "failed_log_prefetched",
    );

    // 5. Jump to the chat a record came from.
    const row = chatRow(chats[1] as ChatRun) as RecordRow;
    const base = {
      c,
      online: true,
      rows: incremental.rows,
      topics: async () => [topicId],
      exists: () => true,
    };
    const found = await resolveRecordTarget(row, base, signal);
    check(
      "target" in found &&
        found.target.topic === topicId &&
        found.target.focus === chats[1]?.messageId,
      "target_found",
    );
    const gone = await resolveRecordTarget(row, { ...base, exists: () => false }, signal);
    check("notice" in gone && gone.notice === "recordBotGone", "target_bot_gone");
    const moved = await resolveRecordTarget(row, { ...base, topics: async () => [id()] }, signal);
    check("notice" in moved && moved.notice === "recordTopicGone", "target_topic_gone");
    // An audit row reaches its chat through the run ledger (chat.runs on the computer).
    const failedAudit = incremental.rows.find(
      (item) => item.type === "audit" && item.entry.runId === failedRun,
    ) as RecordRow;
    chats.push(chatRun(2 * 60_000, "error", { id: failedRun }));
    const viaLedger = await resolveRecordTarget(failedAudit, { ...base, rows: [] }, signal);
    check("target" in viaLedger && viaLedger.target.topic === topicId, "audit_target_via_runs");

    // 6. Unpair clears the copy and the cached logs.
    await storage.forget(computerId);
    const after = await readRecords(storage, computerId);
    check(!after.rows.length && !(await files.peek(computerId, logKey(logRun))), "unpair_clears");
    return {
      ok: true,
      checks,
      window: { auditInWindow: inWindow, auditOnComputer: audit.length - 3, copied: counts },
      maxFrameBytes: Math.max(...harness.frames),
      worstLogFrameBytes: worstFrame,
      logPages: current.pages.length,
      collapsed: failures?.rows.length,
      refusals,
    };
  } finally {
    await harness.stop();
  }
}
