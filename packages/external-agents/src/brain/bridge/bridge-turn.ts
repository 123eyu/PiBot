// One external-agent turn as seen by the `pibot` bridge. Each call the agent makes runs in
// this turn's own context (run, Bot, topic, group task) through Pi Bot's tool gate exactly like a
// call of Pi Bot's own model: `runSynthetic` takes the same policy decision, approval card, budget,
// step record, execution and audit, so there is no second way to run a tool.
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { LocalService, ToolRunContext } from "@pibot/brain/kit";
import type { StreamToolResult } from "@pibot/plugin-sdk";
import { BRIDGE_TOOLS } from "./bridge-tools.ts";

type BridgeCallResult = StreamToolResult;

type ToolRun = ReturnType<LocalService["run"]>;

const refused = (text: string): BridgeCallResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

export const OUTSIDE_TURN =
  "Pi Bot 的工具只在 Pi Bot 正在运行这一轮时可用 / Pi Bot tools work only while Pi Bot is running this turn";

/** Under the 60 s every agent gives an MCP call. */
const WAIT_MS = 45_000;
/** How long a finished call the agent was told to repeat stays joinable. */
const KEEP_MS = 120_000;

export const STILL_WAITING: BridgeCallResult = {
  content: [
    {
      type: "text",
      text: "Pi Bot 正在等用户在审批卡上决定（卡片还开着，最多 10 分钟）。用完全相同的参数再调用一次这个工具来继续等，不要换别的做法。 / Pi Bot is waiting for the user to answer the approval card (it stays open for up to 10 minutes). Call this tool again with exactly the same arguments to keep waiting; do not try another way.",
    },
  ],
};

interface Pending {
  work: Promise<BridgeCallResult>;
  handedOff: boolean;
}

/** Same input, same key, whatever order the agent wrote the fields in. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export class BridgeTurn {
  private run?: ToolRun;
  private queue: Promise<unknown> = Promise.resolve();
  /** Calls not answered yet (or answered "call again"), by tool and input. */
  private readonly pending = new Map<string, Pending>();
  private ended = false;
  /** Files sent with send_file, so the turn's automatic file cards do not repeat them. */
  readonly sent = new Set<string>();

  constructor(
    private readonly local: LocalService,
    readonly context: ToolRunContext,
    private readonly cwd: string,
    private readonly note: (entry: Record<string, unknown>) => void,
  ) {}

  get live() {
    return !this.ended && !this.context.signal.aborted;
  }

  /**
   * One call at a time: Pi Bot's own model gets the batch scheduler, the bridge has no batch, and
   * the browser and the reply's attachments are one shared state per run.
   */
  call(tool: string, input: Record<string, unknown>, signal: AbortSignal) {
    // Agents give an MCP call 60 s (Codex tool_timeout_sec, OpenCode) and then cancel it, while a
    // Pi Bot card waits up to 10 minutes; the Windows acceptance saw cards cancelled and counted
    // as "denied", and the agent's retry stacking a second card. So the call runs on the turn's
    // own signal, the agent is answered within WAIT_MS, and calling again with the same input
    // joins the same call instead of asking twice.
    const key = `${tool}\0${stableJson(input)}`;
    let pending = this.pending.get(key);
    if (!pending) {
      const work = this.queue.then(() => this.dispatch(tool, input));
      this.queue = work.catch(() => undefined);
      const entry: Pending = { work, handedOff: false };
      pending = entry;
      this.pending.set(key, entry);
      void work.finally(() => {
        // Kept a while when the agent was told to call again, so that call gets this result
        // instead of running the step a second time.
        if (!entry.handedOff) this.forget(key, entry);
        else setTimeout(() => this.forget(key, entry), KEEP_MS).unref?.();
      });
    }
    return this.answer(pending, signal);
  }

  private forget(key: string, entry: Pending) {
    if (this.pending.get(key) === entry) this.pending.delete(key);
  }

  private answer(entry: Pending, signal: AbortSignal): Promise<BridgeCallResult> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        entry.handedOff = true;
        resolve(STILL_WAITING);
      }, WAIT_MS);
      timer.unref?.();
      // The agent gave up on this request: nothing reads the answer, the step keeps going.
      signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
      entry.work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private async dispatch(tool: string, input: Record<string, unknown>): Promise<BridgeCallResult> {
    if (!this.live) return refused(OUTSIDE_TURN);
    if (!BRIDGE_TOOLS.has(tool)) return refused(`Unknown tool / 未知工具`);
    const started = performance.now();
    // Created on the first call: a turn whose agent never calls Pi Bot costs nothing.
    this.run ??= this.toolRun();
    let outcome: Awaited<ReturnType<ToolRun["runSynthetic"]>>;
    try {
      outcome = await this.run.runSynthetic(
        { id: `bridge_${randomUUID()}`, tool, input },
        this.context.signal,
      );
    } catch (error) {
      // A program error in the gate: the step was recorded as failed there; the agent gets the
      // same fixed text Pi Bot's model would, never the error's message.
      this.note({
        event: "bridge_call",
        tool,
        outcome: "failed",
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return refused(
        "无法安全执行工具，请检查权限和工作位置 / Could not safely execute the tool; check permissions and workplaces",
      );
    }
    this.note({
      event: "bridge_call",
      tool,
      outcome: !outcome.allowed ? "refused" : outcome.result.isError ? "error" : "ok",
      ms: Math.round(performance.now() - started),
    });
    if (!outcome.allowed) return refused(outcome.reason);
    const result = outcome.result;
    if (tool === "send_file" && !result.isError && Array.isArray(input.paths))
      for (const path of input.paths)
        if (typeof path === "string") this.sent.add(resolve(this.cwd, path));
    return {
      content: [
        { type: "text", text: result.text },
        ...(result.images ?? []).map((image) => ({
          type: "image" as const,
          data: image.data,
          mimeType: image.mimeType,
        })),
      ],
      ...(result.isError ? { isError: true } : {}),
    };
  }

  private toolRun() {
    const run = this.local.run(this.context);
    // Agents take images in MCP results; screenshot results go back as image content.
    // biome-ignore lint/correctness/useHookAtTopLevel: LocalRun.useModel is not a React hook.
    run.useModel(["text", "image"]);
    return run;
  }

  /**
   * The turn is over: later calls are refused. Called after the turn's changes were recorded, so
   * the tool run's own cleanup (browser lease, approvals, write lock) cannot cut them short.
   */
  end() {
    this.ended = true;
    this.run?.finish();
    this.run = undefined;
  }
}
