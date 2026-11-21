import type { LocalToolResult } from "@pibot/agent";
import type { ComputerInput, ComputerPrepared, HostCall } from "@pibot/brain/kit";
import {
  type ComputerApp,
  type ComputerFailure,
  type ComputerHandoffMessage,
  type ComputerStepMethod,
  type HostComputerMethods,
  sameAppId,
} from "@pibot/computer-use-contract/full";
import type { ComputerExecutionRun } from "../../context.ts";
import type { StepInput } from "../steps/computer-steps.ts";
import { declinedKey, type HandoffAnswer, handoffMessage } from "./computer-handoff.ts";
import type { computerRetryGuard } from "./computer-retry-guard.ts";

const DISPLAY_APP_ID = "pibot.display";
const NOT_HANDLED =
  "用户没有处理，不要再尝试这一步，换个办法或告诉用户做不了 / The user did not handle it. Do not try this step again: try another way or tell the user it cannot be done";
const STILL_FAILING =
  "用户处理后仍失败。不要再重试，停下来告诉用户这一步还是做不了 / Still failing after the user handled it. Do not retry: stop and tell the user this step still cannot be done";
const STOPPED = "已停止 / Stopped";

// Wording of the waiting row in Records until the call's own step text replaces it.
const waitingTarget: Record<ComputerInput["tool"], [zh: string, en: string]> = {
  screenshot: ["截图", "screenshot"],
  ui_tree: ["读取界面", "read the window"],
  ui_action: ["操作界面", "act in the window"],
  pointer: ["点击", "click"],
  keys: ["按键", "keys"],
  open_app: ["打开应用", "open the app"],
  open_file: ["打开文件", "open the file"],
};
const failed = (result: unknown): result is ComputerFailure =>
  !!result && typeof result === "object" && "ok" in result && result.ok === false;
const unconfirmed = (result: unknown) =>
  failed(result) && /drain_unconfirmed|client_retired/.test(result.detail ?? "");
const methodOf = (tool: ComputerInput["tool"]): ComputerStepMethod =>
  tool === "pointer" ? "coordinates" : tool === "keys" ? "keys" : "ui";

type Guard = ReturnType<typeof computerRetryGuard>;
interface Card {
  message: ComputerHandoffMessage;
  failure: ComputerFailure;
  stepId?: string;
  answer?: HandoffAnswer;
  /** "Continue" was clicked but the gate refused the retry (grant ended, app blocked since). */
  refused?: string;
}

/**
 * For one computer tool call: wraps the host so a failure the user can fix shows a "come
 * help for a moment" card and the call waits; "continue" passes the gate again and retries the
 * same host call once (same params, the run's current token). Records keep one row for the step
 * ("waiting" → the outcome) and the model gets a fixed instruction instead of the raw failure.
 */
export function handoffCall(
  run: ComputerExecutionRun,
  prepared: ComputerPrepared,
  input: ComputerInput,
  direct: HostCall<typeof HostComputerMethods>,
  guard: Guard,
) {
  const { local, context } = run;
  const zh = context.language === "zh";
  let card: Card | undefined;
  let written = false;
  let restriction: string | undefined;
  const appId = (input.args as { app?: string }).app;
  const app = (): ComputerApp => {
    if (!appId) return { id: DISPLAY_APP_ID, name: zh ? "屏幕" : "Screen" };
    // The name the user knows from the grant card, not the id the model happened to use.
    const held = local.computerGrants
      .grantedApps(context.runId)
      .find((item) => sameAppId(item.id, appId) || item.name.toLowerCase() === appId.toLowerCase());
    return held ?? { id: appId, name: appId };
  };
  const outcome = () => (card?.answer === "continue" ? "continued" : "not_handled");

  const observe = (result: unknown) => {
    // Every operating method answers `{ ok, … }`; the guard only needs that flag and the code.
    if (result && typeof result === "object" && "ok" in result)
      guard.observe(result as { ok: true } | { ok: false; code: string });
  };
  const ask = async (failure: ComputerFailure, signal: AbortSignal): Promise<Card | undefined> => {
    if (context.runWorkplace?.boundary.location?.target.startsWith("runner:")) return undefined;
    if (card || !local.computerHandoff.available(context)) return undefined;
    const streak = guard.streak(failure.code);
    if (!streak || streak.handedOff) return undefined;
    const message = handoffMessage(failure, streak.count);
    if (!message) return undefined;
    const shown = app();
    if (context.computerHandoffDeclined?.has(declinedKey(message, shown))) return undefined;
    streak.handedOff = true;
    const [zhTarget, enTarget] = waitingTarget[input.tool];
    const step = await local.computerSteps.record(context, {
      toolCallId: prepared.call.id,
      app: shown,
      method: methodOf(input.tool),
      stage: "background",
      target: zh ? zhTarget : enTarget,
      result: "error",
      handoff: "waiting",
    });
    const current: Card = { message, failure, ...(step ? { stepId: step.id } : {}) };
    card = current;
    current.answer =
      (await local.computerHandoff.ask(
        context,
        { tool: input.tool, app: shown, failure, message },
        signal,
      )) ?? "cancelled";
    if (current.answer === "decline" || current.answer === "timeout") {
      context.computerHandoffDeclined ??= new Set();
      context.computerHandoffDeclined.add(declinedKey(message, shown));
    }
    return current;
  };

  const host: HostCall<typeof HostComputerMethods> = {
    async call(method, params, signal) {
      const foreground = !!params && "delivery" in params && params.delivery === "foreground";
      const send = async (next: typeof params) => {
        const target = next && "target" in next ? next.target : undefined;
        const raw =
          next && "app" in next
            ? next.app
            : target?.kind === "app"
              ? target.name
              : target?.kind === "file"
                ? target.app
                : undefined;
        if (typeof raw === "string") {
          const checked = await local.computerGrants.dispatchApp(context, input.tool, raw, signal);
          const reason = local.connectionRestriction(context, input.tool, [checked.app]);
          if (reason) {
            restriction = reason;
            return { ok: false, code: "app_blocked", detail: "connection_restricted" } as never;
          }
          // Never let the host resolve the original display name to a different app later.
          next = (
            target
              ? {
                  ...next,
                  target:
                    target.kind === "app"
                      ? { ...target, name: checked.app }
                      : { ...target, app: checked.app },
                }
              : { ...next, app: checked.app }
          ) as typeof next;
        }
        signal.throwIfAborted();
        const lock = local.computerGrants.runs.lock;
        if (foreground) lock.pin(context.runId);
        const answer = await direct.call(method, next, signal);
        if (foreground && !unconfirmed(answer) && !signal.aborted) lock.renew(context.runId);
        return answer;
      };
      const result = await send(params);
      observe(result);
      // The user just took computer control away: never ask them to come and help with it.
      if (local.computerGrants.stoppedByUser(context.runId)) return result;
      if (restriction) return result;
      if (unconfirmed(result)) return result;
      if (!failed(result) || card) return result;
      // Replaying after a partial batch could press buttons or insert text twice.
      if (result.completed !== undefined && result.completed > 0) return result;
      // These failures carry a corrective next step; let the model choose before asking a human.
      if (result.windows?.length || result.detail === "no_focused_text_input") return result;
      // The failed call has drained. Handing the computer to the user ends its old lease.
      if (foreground) local.computerGrants.runs.lock.release(context.runId);
      const asked = await ask(result, signal);
      if (asked?.answer !== "continue") return result;
      // Not a way around the gate: the policy, blocklist and grant are checked again first.
      const decision = await local.computerGrants.authorize(context, prepared.call, signal);
      const token = local.computerGrants.token(context.runId);
      if (!decision.allow || !token) {
        asked.refused = decision.reason ?? STILL_FAILING;
        return result;
      }
      if (
        foreground &&
        (await local.computerGrants.foreground(
          context,
          { app: app().id, description: zh ? "接管后继续操作" : "Continue after handoff" },
          signal,
        )) !== "allow"
      ) {
        asked.refused = STILL_FAILING;
        return result;
      }
      const retry = await send({ ...params, token } as typeof params);
      observe(retry);
      return retry;
    },
  };

  return {
    host,
    /** Step recording for the call: the card's waiting row takes the step's outcome. */
    record(step: StepInput) {
      if (card?.stepId && !written) {
        written = true;
        return local.computerSteps.finishHandoff(context, card.stepId, {
          ...step,
          handoff: outcome(),
        });
      }
      return local.computerSteps.record(context, step);
    },
    /** The tool result after a card: the retry's own result, or a fixed instruction. */
    async finish(result: LocalToolResult): Promise<LocalToolResult> {
      if (restriction) return { ...result, text: restriction, isError: true };
      if (!card) return result.isError ? { ...result, text: guard.annotate(result.text) } : result;
      if (card.stepId && !written) {
        written = true;
        const [zhTarget, enTarget] = waitingTarget[input.tool];
        await local.computerSteps.finishHandoff(context, card.stepId, {
          stage: "background",
          target: zh ? zhTarget : enTarget,
          result: result.isError ? "error" : "done",
          handoff: outcome(),
        });
      }
      if (card.answer === "cancelled") return { text: STOPPED, isError: true };
      if (card.answer !== "continue") {
        const { code, detail } = card.failure;
        return { text: `${NOT_HANDLED} (${code}${detail ? `: ${detail}` : ""})`, isError: true };
      }
      if (card.refused) return { text: `${card.refused}\n${STILL_FAILING}`, isError: true };
      return result.isError ? { ...result, text: `${result.text}\n${STILL_FAILING}` } : result;
    },
  };
}
