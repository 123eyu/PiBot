import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import {
  acpMethods,
  acpProtocolVersion,
  createAcpClient,
  createAcpNdJsonStream,
} from "../../packages/acp/src/index.ts";
import type { AcpGroupSnapshot } from "../../packages/acp/src/types.ts";
import { drainAcpPipe } from "./acp-pipe-drain.ts";
import { groupSnapshot } from "./group-target.ts";
import { failureCode, sessionLost, throwIfCancelled } from "./session-fallback.ts";

/*
 * One ACP turn against the running Pi Bot: `Pi Bot --acp` is only a pipe to
 * the app's own brain, so the dev Bot works under the app's normal policy, sandbox and approvals.
 * Each step is a new connection; session/load continues the task's topic while the app keeps
 * the session, otherwise the worktree, its task note and the prompt carry the context.
 */

export interface AcpTurnInput {
  onDispatch?: (identity: AcpDispatchIdentity) => void;
  group?: string;
  onGroupState?: (snapshot: AcpGroupSnapshot) => void;
  /** The running app's executable; its version must match the running owner. */
  app: string;
  cwd: string;
  /** Exact Bot name to switch to; the turn stops if no such Bot exists. */
  bot: string;
  prompt: string;
  logPath: string;
  signal: AbortSignal;
  /** Continue this ACP session in its topic (session/load); falls back to a new one. */
  sessionId?: string;
  /**
   * Work in this existing topic instead of opening one (session/new with `pibot/topic`).
   * The topic must belong to `bot` and its folders must include `cwd`.
   */
  topicId?: string;
  /** Run the Bot on this model (provider display name + model id), via the "model" option. */
  model?: { provider: string; id: string };
  /**
   * Called every 10 minutes while an approval card stays unanswered in the app: nobody may be
   * sitting there, so the wait has to be visible instead of looking like a hung run.
   */
  onApprovalWait?: (input: { minutes: number; title: string }) => void;
  /**
   * Called once when the card stays unanswered for APPROVAL_WAIT_LIMIT_MS: the turn is cancelled
   * then, so a supervisor can resume with that reason instead of waiting all night.
   */
  onApprovalTimeout?: (input: { minutes: number; title: string }) => void;
}

export interface AcpDispatchIdentity {
  dispatchId: string;
  sessionId: string;
  botId: string;
  startedAt: string;
  targetKind?: "bot" | "group";
  groupId?: string;
}

/**
 * The turn's token usage as the app reports it in the prompt response `_meta`. Every
 * field is optional: a provider that reports no cache numbers leaves them out, and an older app
 * sends no `pibot/usage` at all. Validated by hand because this tool has no zod dependency.
 */
export interface AcpTurnUsage {
  requests?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

const USAGE_KEYS = ["requests", "input", "output", "cacheRead", "cacheWrite"] as const;

function parseUsage(value: unknown): AcpTurnUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const usage: AcpTurnUsage = {};
  for (const key of USAGE_KEYS) {
    const field = source[key];
    if (typeof field === "number" && Number.isFinite(field)) usage[key] = field;
  }
  return Object.keys(usage).length ? usage : undefined;
}

export interface AcpTurnResult {
  stopReason: string;
  text: string;
  sessionId: string;
  /** Token usage of this turn; undefined when the app did not report any. */
  usage?: AcpTurnUsage;
  /** The Bot's id (its ACP mode id): retro reads this Bot's runs from the app log. */
  botId?: string;
  group?: AcpGroupSnapshot;
  /** False when the requested session could not be loaded and a new topic was started. */
  continued: boolean;
  tools: number;
  failedTools: number;
  durationMs: number;
  /** The turn was cancelled because an approval card went unanswered past the limit. */
  approvalTimeout: boolean;
}

export type AcpHarnessCode =
  | "app_not_running"
  | "bot_missing"
  | "group_missing"
  | "acp_busy"
  /** Pi Bot is running headless: without a GUI client it refuses interactive ACP work. */
  | "interactive_unavailable"
  | "version_mismatch"
  /** The requested model is not among the models Pi Bot can run now. */
  | "model_missing"
  /** The Bot's run failed inside the app (model network, missing key …); detail = run code. */
  | "run_failed"
  | "acp_failed";
export class AcpHarnessError extends Error {
  group?: AcpGroupSnapshot;
  /** Only this prompt's correlated owner refusal proves its dispatch was never admitted. */
  rejectedDispatchId?: string;
  readonly code: AcpHarnessCode;
  readonly detail: string | undefined;
  /** The session the failure happened in, so the next step can continue its topic. */
  sessionId: string | undefined;
  constructor(code: AcpHarnessCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail;
  }
}

/** Run failures worth continuing the same topic after a pause; others need a person. */
// proxy_unavailable: the owner's local proxy (mihomo) drops out for minutes at a time
// (2026-11-04 14:31–14:35) and comes back; a pilot run stopped on it.
export const TRANSIENT_RUN_FAILURES = new Set([
  "network",
  "rate_limited",
  "timeout",
  "proxy_unavailable",
]);

/** Approval reminders repeat at this interval; the first one is also the first report. */
const approvalWaitReportMs = 10 * 60_000;

/**
 * A card nobody answers keeps the turn alive forever (2026-11-05: an unattended write outside the
 * working location did exactly that). Cancelling after this is still fail closed — nothing runs
 * without the person's answer — and the turn ends so the supervisor resumes with the reason.
 */
const APPROVAL_WAIT_LIMIT_MS = 20 * 60_000;

const log = (path: string, line: string) =>
  appendFileSync(path, `${new Date().toISOString()} ${line.replaceAll("\n", "\\n")}\n`);

function classify(stderr: string, error: unknown): AcpHarnessError {
  const code = failureCode(error);
  // The app names these cases explicitly instead of a generic internal error, so the
  // caller can wait for a window/connection or start over on purpose instead of guessing.
  if (code === "interactive_client_unavailable")
    return new AcpHarnessError("interactive_unavailable");
  if (code === "acp_busy" || code === "session_busy" || code === "session_capacity")
    return new AcpHarnessError("acp_busy");
  if (code === "bot_missing") return new AcpHarnessError("bot_missing");
  if (code === "cancelled") return new AcpHarnessError("acp_failed", "cancelled");
  // Any other named refusal: the run did not happen and only a person can clear it.
  if (code) return new AcpHarnessError("run_failed", code);
  const text = `${stderr} ${error instanceof Error ? error.message : String(error)}`;
  // Older apps only carry the message text; keep recognizing it after an app version mismatch.
  if (text.includes("interactive_client_unavailable") || text.includes("no interactive client"))
    return new AcpHarnessError("interactive_unavailable");
  for (const code of ["app_not_running", "acp_busy", "version_mismatch"] as const)
    if (text.includes(code)) return new AcpHarnessError(code);
  return new AcpHarnessError("acp_failed", text.trim().slice(-400));
}

export async function runAcpTurn(input: AcpTurnInput): Promise<AcpTurnResult> {
  if (input.group && input.model)
    throw new AcpHarnessError("model_missing", "group_model_unsupported");
  const started = Date.now();
  const child = spawn(input.app, ["--acp"], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
  child.on("error", () => {
    /* The connection request reports the harness failure. */
  });
  let text = "";
  let selectedGroupId: string | undefined;
  let selectedCoordinatorId: string | undefined;
  let latestGroup: AcpGroupSnapshot | undefined;
  let metadataFailed = false;
  const sameGroupTurn = (snapshot: AcpGroupSnapshot) =>
    snapshot.groupId === selectedGroupId &&
    (!latestGroup ||
      ["runId", "assistantMessageId", "topicId", "cycleId", "budgetRootRunId"].every(
        (key) =>
          snapshot[key as keyof AcpGroupSnapshot] === latestGroup?.[key as keyof AcpGroupSnapshot],
      ));

  /** The session's "model" option as last reported (new / load / config_option_update). */
  let modelOption: { currentValue: string; options: { value: string; name: string }[] } | undefined;
  const rememberModel = (configOptions: unknown) => {
    const option = (
      configOptions as { id?: string; currentValue?: string; options?: unknown }[] | null
    )?.find((entry) => entry.id === "model");
    if (option && typeof option.currentValue === "string" && Array.isArray(option.options))
      modelOption = {
        currentValue: option.currentValue,
        options: (option.options as { value?: unknown; name?: unknown }[]).flatMap((entry) =>
          typeof entry.value === "string" && typeof entry.name === "string"
            ? [{ value: entry.value, name: entry.name }]
            : [],
        ),
      };
  };
  let tools = 0;
  let failedTools = 0;
  let approvalTimeout = false;
  /** Cancels the running prompt; set once the session exists, the approval handler runs later. */
  let cancelSession: (() => void) | undefined;
  const client = createAcpClient({ name: "pibot-dev" });
  // Approvals are the person's: leave the request open until the desktop answers (the app cancels
  // this side then), never answer from the script.
  client.onRequest(acpMethods.client.session.requestPermission, ({ params, signal }) => {
    const title = params.toolCall.title ?? params.toolCall.toolCallId;
    log(input.logPath, `[approval] ${title}`);
    return new Promise((resolve) => {
      // 2026-11-05: a write outside the working location waited unattended and the whole workflow
      // hung on the card. ACP never answers for the person: report the wait, then cancel the turn
      // at the limit (fail closed: no answer means no tool runs) so it cannot hang all night.
      let minutes = 0;
      const timer = setInterval(() => {
        minutes += approvalWaitReportMs / 60_000;
        if (minutes * 60_000 >= APPROVAL_WAIT_LIMIT_MS) {
          clearInterval(timer);
          approvalTimeout = true;
          log(input.logPath, `[approval_timeout] ${minutes} min ${title}`);
          input.onApprovalTimeout?.({ minutes, title });
          cancelSession?.();
          resolve({ outcome: { outcome: "cancelled" } });
          return;
        }
        input.onApprovalWait?.({ minutes, title });
        log(input.logPath, `[approval_wait] ${minutes} min ${title}`);
      }, approvalWaitReportMs);
      // The turn must not be kept alive by a reminder for a card it is already waiting on.
      timer.unref();
      const cancelled = () => {
        clearInterval(timer);
        resolve({ outcome: { outcome: "cancelled" } });
      };
      if (signal?.aborted) cancelled();
      signal?.addEventListener("abort", cancelled, { once: true });
      input.signal.addEventListener("abort", cancelled, { once: true });
    });
  });
  client.onNotification(acpMethods.client.session.update, ({ params }) => {
    const update = params.update as Record<string, unknown> & { sessionUpdate: string };
    const meta = (update._meta as Record<string, unknown> | undefined)?.["pibot/group"];
    if (meta !== undefined && selectedGroupId) {
      const snapshot = groupSnapshot(meta);
      if (!snapshot || !sameGroupTurn(snapshot)) metadataFailed = true;
      else {
        latestGroup = snapshot;
        try {
          input.onGroupState?.(snapshot);
        } catch {
          metadataFailed = true;
        }
      }
      if (metadataFailed) {
        cancelSession?.();
        connection.close();
        child.stdin.end();
      }
    }
    if (update.sessionUpdate === "agent_message_chunk") {
      const content = update.content as { type?: string; text?: string } | undefined;
      if (content?.type === "text" && content.text) text += content.text;
    } else if (update.sessionUpdate === "tool_call") {
      tools += 1;
      log(input.logPath, `[tool] ${String(update.title ?? update.toolCallId ?? "")}`);
    } else if (update.sessionUpdate === "config_option_update") {
      rememberModel(update.configOptions);
    } else if (update.sessionUpdate === "tool_call_update" && update.status === "failed") {
      failedTools += 1;
      // The head of the failure (exit code, stderr, error text) is what diagnosis needs; the log
      // is local to .pibot-dev and the excerpt stays short.
      // Failures carry their text in `content` (ACP tool-call content blocks); rawOutput is often
      // absent for them.
      const content = Array.isArray(update.content)
        ? (update.content as { content?: { text?: string } }[])
            .map((block) => block.content?.text ?? "")
            .join(" ")
        : "";
      const output =
        content || (update.rawOutput === undefined ? "" : JSON.stringify(update.rawOutput));
      log(
        input.logPath,
        `[tool failed] ${String(update.toolCallId ?? "")} ${output.slice(0, 300)}`,
      );
    }
  });
  const connection = client.connect(
    createAcpNdJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ),
  );
  let sessionId = "";
  let cancelTimeout: ReturnType<typeof setTimeout> | undefined;
  let promptDispatched = false;
  let dispatch: AcpDispatchIdentity | undefined;
  const cancelled = () => {
    if (promptDispatched) {
      cancelSession?.();
      // Pipe disconnection is not proof of brain drain; onDispatch gives the caller a durable
      // identity to retain as unknown if cancellation cannot be certified.
      cancelTimeout = setTimeout(() => {
        connection.close();
        child.stdin.end();
        child.kill("SIGTERM");
      }, 20_000);
    } else {
      connection.close();
      child.stdin.end();
    }
  };
  input.signal.addEventListener("abort", cancelled, { once: true });
  try {
    // The caller's signal covers the whole preparation, not only the turn: a cancelled or
    // timed-out run must not still create a topic, rebind folders or import MCP servers.
    const prepare = { cancellationSignal: input.signal };
    const abortIfCancelled = () =>
      throwIfCancelled(input.signal, () => new AcpHarnessError("acp_failed", "cancelled"));
    const initialized = await connection.agent.request(
      acpMethods.agent.initialize,
      {
        protocolVersion: acpProtocolVersion,
        // No editor fs / terminal: Pi Bot runs everything in its own sandbox.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "pibot-dev", version: "1" },
      },
      prepare,
    );
    abortIfCancelled();
    if (input.group && initialized._meta?.["pibot/groups"] !== true)
      throw new AcpHarnessError("acp_failed", "group_unsupported");
    let continued = false;
    let modes:
      | {
          currentModeId: string;
          availableModes: { id: string; name: string; _meta?: Record<string, unknown> | null }[];
        }
      | undefined;
    if (input.sessionId) {
      try {
        const loaded = await connection.agent.request(
          acpMethods.agent.session.load,
          {
            sessionId: input.sessionId,
            cwd: input.cwd,
            mcpServers: [],
            // The brain forgets this mark on restart, so every load repeats it.
            _meta: { "pibot/autocheck": false },
          },
          prepare,
        );
        sessionId = input.sessionId;
        modes = loaded.modes ?? undefined;
        rememberModel(loaded.configOptions);
        continued = true;
      } catch (error) {
        // An app restart forgets ACP sessions; the worktree and its notes carry the context. Every
        // other refusal (busy, permission, quota, cancellation) keeps the topic: this step fails
        // and the next one tries the same session again.
        if (!sessionLost(error)) {
          const failure = classify(stderr, error);
          failure.sessionId = input.sessionId;
          throw failure;
        }
        log(
          input.logPath,
          `[session] ${input.sessionId} is gone; new topic: ${String(error).slice(0, 200)}`,
        );
      }
    }
    abortIfCancelled();
    if (!continued) {
      const created = await connection.agent.request(
        acpMethods.agent.session.new,
        {
          cwd: input.cwd,
          mcpServers: [],
          // Maintainers 2026-11-04: the dev Bot's task topics run in YOLO so ordinary cards don't page
          // the owner; danger cards (outside the sandbox, protected paths …) still ask.
          // Maintainers 2026-11-05: no automatic check inside the task's turns; pibot-dev runs
          // check:changed / verify after the turn, so a second round only costs time.
          // A named topic is the person's, so it keeps its own YOLO setting.
          _meta: {
            ...(input.topicId ? { "pibot/topic": input.topicId } : { "pibot/yolo": true }),
            ...(input.group ? { "pibot/group": input.group } : { "pibot/bot": input.bot }),
            "pibot/autocheck": false,
          },
        },
        prepare,
      );
      sessionId = created.sessionId;
      modes = created.modes ?? undefined;
      rememberModel(created.configOptions);
    }
    abortIfCancelled();
    const groupModeId = input.group?.startsWith("group:") ? input.group : `group:${input.group}`;
    const exactGroup = input.group
      ? modes?.availableModes.find((mode) => mode.id === groupModeId)
      : undefined;
    const choices = exactGroup
      ? [exactGroup]
      : (modes?.availableModes.filter((mode) =>
          input.group
            ? !input.group.startsWith("group:") &&
              mode.id.startsWith("group:") &&
              mode.name === input.group
            : !mode.id.startsWith("group:") && mode.name === input.bot,
        ) ?? []);
    const mode = choices.length === 1 ? choices[0] : undefined;
    if (!mode)
      throw new AcpHarnessError(
        input.group ? "group_missing" : "bot_missing",
        "target_unavailable",
      );
    selectedGroupId = input.group ? mode.id.slice(6) : undefined;
    if (selectedGroupId) {
      const target = mode._meta?.["pibot/target"] as
        | { kind?: string; groupId?: string; coordinatorBotId?: string }
        | undefined;
      if (
        target?.kind !== "group" ||
        target.groupId !== selectedGroupId ||
        typeof target.coordinatorBotId !== "string" ||
        !/^[a-zA-Z0-9:_-]{1,128}$/.test(target.coordinatorBotId)
      )
        throw new AcpHarnessError("acp_failed", "group_target_unconfirmed");
      selectedCoordinatorId = target.coordinatorBotId;
    }
    if (modes?.currentModeId !== mode.id)
      await connection.agent.request(
        acpMethods.agent.session.setMode,
        {
          sessionId,
          modeId: mode.id,
        },
        prepare,
      );
    abortIfCancelled();
    if (input.model && !input.group) {
      const { provider, id } = input.model;
      // Values are "<provider id>/<model id>"; names are "<provider name> · <model name>".
      const choice = modelOption?.options.find(
        (option) =>
          option.value.endsWith(`/${id}`) &&
          option.name.toLowerCase().startsWith(`${provider.toLowerCase()} ·`),
      );
      if (!choice) throw new AcpHarnessError("model_missing", `${provider} ${id}`);
      if (modelOption?.currentValue !== choice.value) {
        abortIfCancelled();
        const set = await connection.agent.request(
          acpMethods.agent.session.setConfigOption,
          {
            sessionId,
            configId: "model",
            value: choice.value,
          },
          prepare,
        );
        rememberModel(set.configOptions);
        log(input.logPath, `[model] ${input.bot} → ${choice.name}`);
      }
    }
    abortIfCancelled();
    log(input.logPath, `[session] ${sessionId} bot=${input.bot} cwd=${input.cwd}`);
    const abort = () =>
      void connection.agent.notify(acpMethods.agent.session.cancel, { sessionId }).catch(() => {});
    cancelSession = abort;
    dispatch = {
      dispatchId: randomUUID(),
      sessionId,
      botId: selectedCoordinatorId ?? mode.id,
      ...(selectedGroupId ? { targetKind: "group" as const, groupId: selectedGroupId } : {}),
      startedAt: new Date().toISOString(),
    };
    input.onDispatch?.(dispatch);
    abortIfCancelled();
    promptDispatched = true;
    const done = await connection.agent.request(acpMethods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: input.prompt }],
    });
    cancelSession = undefined;
    // The app attaches this turn's token totals to the prompt response; an older app
    // sends nothing, which is not an error.
    if (input.group) {
      const snapshot = groupSnapshot(done._meta?.["pibot/group"]);
      if (
        !snapshot ||
        !sameGroupTurn(snapshot) ||
        metadataFailed ||
        (done.stopReason === "end_turn" &&
          !(
            snapshot.complete &&
            snapshot.terminal &&
            snapshot.drained &&
            snapshot.state === "completed"
          ))
      )
        throw new AcpHarnessError("acp_failed", "group_receipt_unconfirmed");
      latestGroup = snapshot;
      input.onGroupState?.(latestGroup);
    }
    const usage = parseUsage(done._meta?.["pibot/usage"]);
    log(
      input.logPath,
      `[done] ${done.stopReason} tools=${tools} failed=${failedTools} approval_timeout=${approvalTimeout}${usage ? ` usage=${JSON.stringify(usage)}` : ""}`,
    );
    log(input.logPath, `[reply] ${text.slice(0, 4000)}`);
    return {
      ...(latestGroup
        ? {
            group: latestGroup,
            botId: latestGroup.runs.find((run) => run.runId === latestGroup?.runId)?.botId,
          }
        : { botId: mode.id }),
      stopReason: done.stopReason,
      text,
      sessionId,
      continued,
      tools,
      failedTools,
      durationMs: Date.now() - started,
      approvalTimeout,
      ...(usage ? { usage } : {}),
    };
  } catch (error) {
    const failure = metadataFailed
      ? new AcpHarnessError("acp_failed", "group_metadata_unavailable")
      : error instanceof AcpHarnessError
        ? error
        : classify(stderr, error);
    if (sessionId) failure.sessionId = sessionId;
    const remoteGroup = groupSnapshot(
      (error as { data?: Record<string, unknown> })?.data?.["pibot/group"],
    );
    if (remoteGroup && sameGroupTurn(remoteGroup)) latestGroup = remoteGroup;
    if (latestGroup) failure.group = latestGroup;
    const data = (error as { data?: Record<string, unknown> })?.data;
    const rejected = data?.["pibot/promptRejected"] as
      | { sessionId?: unknown; groupId?: unknown; reason?: unknown }
      | undefined;
    // Only the response to this dispatched prompt can release its marker; load/new refusals,
    // generic business errors and any received run evidence remain unconfirmed.
    if (
      promptDispatched &&
      dispatch?.targetKind === "group" &&
      !latestGroup &&
      !metadataFailed &&
      data?.["pibot/group"] === undefined &&
      (error as { code?: unknown })?.code === -32602 &&
      failure.code === "run_failed" &&
      failure.detail === "group_unavailable" &&
      rejected?.sessionId === dispatch.sessionId &&
      rejected.groupId === dispatch.groupId &&
      rejected.reason === "group_topic_stale"
    )
      failure.rejectedDispatchId = dispatch.dispatchId;
    throw failure;
  } finally {
    input.signal.removeEventListener("abort", cancelled);
    clearTimeout(cancelTimeout);
    connection.close();
    child.stdin.end();
    if (!(await drainAcpPipe(child, exited)))
      // biome-ignore lint/correctness/noUnsafeFinally: Unknown cleanup must supersede a successful reply; otherwise callers could release a live bridge.
      throw new AcpHarnessError("acp_failed", "pipe_cleanup_unconfirmed");
  }
}

/**
 * Archives the topics of finished task sessions (ACP session/delete; maintainers 2026-11-05: tidy
 * leftover topics). One connection for the batch; a session that is open elsewhere is skipped.
 */
export async function deleteAcpSessions(app: string, sessionIds: string[]) {
  const child = spawn(app, ["--acp"], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const connection = createAcpClient({ name: "pibot-dev" }).connect(
    createAcpNdJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ),
  );
  const deleted: string[] = [];
  const skipped: { sessionId: string; reason: string }[] = [];
  try {
    await connection.agent.request(acpMethods.agent.initialize, {
      protocolVersion: acpProtocolVersion,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "pibot-dev", version: "1" },
    });
    for (const sessionId of sessionIds)
      try {
        await connection.agent.request(acpMethods.agent.session.delete, { sessionId });
        deleted.push(sessionId);
      } catch (error) {
        skipped.push({ sessionId, reason: String(error).slice(0, 200) });
      }
  } finally {
    connection.close();
    child.stdin.end();
    const timeout = setTimeout(() => child.kill("SIGTERM"), 10_000);
    await exited;
    clearTimeout(timeout);
  }
  return { deleted, skipped };
}
