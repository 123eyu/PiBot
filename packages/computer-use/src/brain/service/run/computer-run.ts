import { isAbsolute, join, posix, win32 } from "node:path";
import type { LocalToolResult } from "@pibot/agent";
import type { ComputerInput, ComputerPrepared, HostCall } from "@pibot/brain/kit";
import type {
  ComputerApp,
  ComputerDelivery,
  ComputerFailure,
  ComputerStepAction,
  HostComputerMethods,
  ImageContent,
  Result,
} from "@pibot/computer-use-contract/full";
import type { ComputerExecutionRun } from "../../context.ts";
import { STOPPED_BY_USER } from "../grants/computer-grants.ts";
import { handoffCall } from "../handoff/computer-handoff-run.ts";
import { computerRetryGuard } from "../handoff/computer-retry-guard.ts";
import type { StepInput } from "../steps/computer-steps.ts";
import {
  computerProgress,
  computerStoppedText,
  finishComputerProgress,
} from "./computer-progress.ts";
import { failureText, treeText, treeTruncationText, untrusted } from "./computer-text.ts";
import { focusValueText } from "./computer-value.ts";

type Input = ComputerInput;
type Outcome<K extends keyof typeof HostComputerMethods> = Result<typeof HostComputerMethods, K>;

// Model-facing screenshots: long edge near the vision models' native size, bounded bytes so five
// stay well inside the 20 MB image budget of one tool result (pibot-tools).
const SCREENSHOT_EDGE = 1568;
const SCREENSHOT_BYTES = 1024 * 1024;
const DISPLAY_APP_ID = "pibot.display";
// Recent screenshots per run, for attaching to the pointer steps that click on them.
const SHOTS_KEPT = 3;

/**
 * Executes an operating-the-computer tool through `host.computer.*` with the run's
 * grant token. Refusals come back as text for the model; `needs_foreground` goes through the
 * grant gate's foreground confirmation and is retried once in the foreground. open_app /
 * open_file are opened by the host; a file path first passes the read_file gate.
 */
export async function executeComputer(
  run: ComputerExecutionRun,
  prepared: ComputerPrepared,
  input: Input,
  signal: AbortSignal,
): Promise<LocalToolResult> {
  const { local, context } = run;
  const stoppedByUser = () => local.computerGrants.stoppedByUser(context.runId);
  if (stoppedByUser()) return { text: STOPPED_BY_USER, isError: true };
  if (computerProgress(context).stopped)
    return { text: computerStoppedText(context), isError: true };
  const direct = local.computerHost(context);
  if (!direct)
    return {
      text: "这台电脑上不能操作电脑 / Operating the computer is unavailable on this host",
      isError: true,
    };
  const token = local.computerGrants.token(context.runId);
  if (!token)
    return {
      text: "这次运行没有操作电脑授权 / This run has no permission to operate the computer",
      isError: true,
    };
  const guard = computerRetryGuard(context, input.tool, input.args.app);
  if (guard.blocked) {
    return finishComputerProgress(run, input, { text: guard.blocked, isError: true });
  }
  // The retry guard's host wrapper, plus the "come help for a moment" card on failures
  // the user can fix (permissions, windows, the retry limit).
  const handoff = handoffCall(run, prepared, input, direct, guard);
  let failed = false;
  const host: HostCall<typeof HostComputerMethods> = {
    async call(method, params, active) {
      const result = await handoff.host.call(method, params, active);
      failed =
        !!result &&
        "ok" in result &&
        !result.ok &&
        result.code !== "needs_foreground" &&
        result.code !== "cancelled";
      return result;
    },
  };
  const result = await handoff.finish(
    await executeWith(run, prepared, input, signal, host, token, handoff.record),
  );
  signal.throwIfAborted();
  // The revoke cancelled this call mid-way; its "cancelled" / "skipped" result would read as a
  // failure to retry, and it is no lack of progress either.
  if (stoppedByUser()) return { text: STOPPED_BY_USER, isError: true };
  return finishComputerProgress(run, input, result, failed);
}

async function executeWith(
  run: ComputerExecutionRun,
  prepared: ComputerPrepared,
  input: Input,
  signal: AbortSignal,
  host: HostCall<typeof HostComputerMethods>,
  token: string,
  record: (step: StepInput) => Promise<unknown>,
): Promise<LocalToolResult> {
  const { local, context } = run;
  const zh = context.language === "zh";
  context.computerElements ??= new Map();
  const elements = context.computerElements;
  const appOf = (id: string | undefined): ComputerApp =>
    id ? { id, name: id } : { id: DISPLAY_APP_ID, name: zh ? "屏幕" : "Screen" };
  const step = (
    app: ComputerApp,
    method: "ui" | "coordinates" | "keys",
    target: string,
    result: "done" | "error" | "denied" | "skipped",
    stage: "background" | "foreground" = "background",
    image?: ImageContent,
    action?: ComputerStepAction,
  ) =>
    record({
      toolCallId: prepared.call.id,
      app,
      method,
      stage,
      target,
      result,
      ...(image ? { image } : {}),
      ...(action ? { action } : {}),
    });
  const refused = async (
    failure: ComputerFailure,
    app: ComputerApp,
    method: "ui" | "coordinates" | "keys",
    target: string,
    action?: ComputerStepAction,
  ): Promise<LocalToolResult> => {
    await step(
      app,
      method,
      target,
      ["app_not_granted", "app_blocked", "coordinates_not_allowed", "secure_field"].includes(
        failure.code,
      )
        ? "denied"
        : "error",
      "background",
      undefined,
      action,
    );
    return {
      text: `${failureText(failure)}${
        failure.completed !== undefined
          ? `\n${zh ? "已完成" : "Completed"}: ${failure.completed}; ${zh ? "不要重放整批；核对后只提交尚未执行的动作" : "Do not replay the batch; verify before submitting only the remaining actions"}`
          : ""
      }`,
      isError: true,
    };
  };
  /** Pointer / keys / menus: background first, then the user-confirmed foreground. */
  const deliver = async <
    K extends "host.computer.pointer" | "host.computer.keys" | "host.computer.uiAction",
  >(
    send: (delivery: ComputerDelivery) => Promise<Outcome<K>>,
    app: ComputerApp,
    method: "ui" | "coordinates" | "keys",
    target: string,
    description = target,
    image?: ImageContent,
    done?: (delivery: "background" | "foreground") => string,
  ): Promise<LocalToolResult> => {
    let result = await send("auto");
    if (!result.ok && result.code === "needs_foreground") {
      if (context.runWorkplace?.boundary.location?.target.startsWith("runner:")) {
        await step(app, method, target, "error", "background", image);
        return {
          text: "执行端暂不支持需要切到前台的操作，请使用后台操作或请用户手动处理 / Runner foreground operations are unsupported; use background actions or ask the user to act manually (runner_foreground_unsupported)",
          isError: true,
        };
      }
      const answer = await local.computerGrants.foreground(
        context,
        { app: app.id, description },
        signal,
      );
      if (answer === "skip") {
        await step(app, method, target, "skipped", "foreground", image);
        return {
          text: "用户跳过了这个前台步骤，请换个办法或告诉用户需要手动做什么 / The user skipped this foreground step; try another way or tell the user what to do by hand",
          isError: true,
        };
      }
      result = await send("foreground");
    }
    if (!result.ok) return refused(result, app, method, target);
    const delivery = result.delivery ?? "background";
    await step(app, method, target, "done", delivery, image);
    if (done) return { text: done(delivery) };
    return {
      text: zh
        ? `完成（${result.delivery === "background" ? "后台" : "前台"}）`
        : `Done (${result.delivery})`,
    };
  };

  if (input.tool === "screenshot") {
    const { app, window, display, region } = input.args;
    const result = await host.call(
      "host.computer.screenshot",
      {
        token,
        ...(app ? { app } : {}),
        ...(window ? { window } : {}),
        ...(display !== undefined ? { display } : {}),
        ...(region ? { region } : {}),
        maxEdge: SCREENSHOT_EDGE,
        maxBytes: SCREENSHOT_BYTES,
      },
      signal,
    );
    const target = app ? (window ?? "window") : `display ${display ?? 0}`;
    if (!result.ok) return refused(result, appOf(app), "ui", target);
    await step(appOf(app), "ui", target, "done", "background", result.image);
    // Pointer steps show their click on the screenshot they refer to (the step view draws the
    // marker).
    context.computerShots ??= new Map();
    context.computerShots.set(result.screenshotId, result.image);
    for (const old of [...context.computerShots.keys()].slice(0, -SHOTS_KEPT))
      context.computerShots.delete(old);
    return {
      text: `${untrusted}\n${JSON.stringify({
        screenshotId: result.screenshotId,
        width: result.width,
        height: result.height,
        scope: result.scope,
        masked: result.masked,
      })}`,
      images: [result.image],
    };
  }
  if (input.tool === "ui_tree") {
    const { app, window, depth, filter, maxNodes } = input.args;
    const result = await host.call(
      "host.computer.uiTree",
      {
        token,
        app,
        ...(window ? { window } : {}),
        ...(depth ? { depth } : {}),
        ...(filter ? { filter } : {}),
        ...(maxNodes !== undefined ? { maxNodes } : {}),
      },
      signal,
    );
    if (!result.ok) return { text: failureText(result), isError: true };
    // Step descriptions name elements by role and name, never by values or typed text.
    elements.clear();
    for (const e of result.elements) elements.set(e.id, `${e.role}${e.name ? ` ${e.name}` : ""}`);
    return {
      text: `${untrusted}\nwindow ${JSON.stringify(result.window)}${treeTruncationText(result)}\n${treeText(result.elements)}`,
    };
  }
  if (input.tool === "ui_action") {
    const { app, window, elementId, action, value, path } = input.args;
    if (action === "batch") {
      const result = await host.call(
        "host.computer.uiAction",
        {
          token,
          app,
          ...(window ? { window } : {}),
          action: "batch",
          actions: input.args.actions ?? [],
        },
        signal,
      );
      const target = `batch ${input.args.actions?.length ?? 0}`;
      if (!result.ok) return refused(result, appOf(app), "ui", target);
      await step(appOf(app), "ui", target, "done");
      return { text: JSON.stringify({ completed: result.completed, effect: result.effect }) };
    }
    // The tool schema pairs action "menu" with path and every other action with elementId.
    if (action === "menu" || elementId === undefined) {
      const menu = (path ?? []).join(" › ");
      return deliver<"host.computer.uiAction">(
        (delivery) =>
          host.call(
            "host.computer.uiAction",
            {
              token,
              app,
              ...(window ? { window } : {}),
              action: "menu",
              path: path ?? [],
              delivery,
            },
            signal,
          ),
        appOf(app),
        "ui",
        `menu ${menu}`.slice(0, 200),
        `${zh ? "菜单" : "menu"} ${menu}`.slice(0, 200),
        undefined,
        (delivery) =>
          zh
            ? `已${delivery === "background" ? "在后台" : "在前台"}按下菜单项，请用 ui_tree 核对效果`
            : `Pressed the menu item (${delivery}); check the effect with ui_tree`,
      );
    }
    const target = `${action} ${(elements.get(elementId) ?? "element").slice(0, 200)}`;
    const result = await host.call(
      "host.computer.uiAction",
      {
        token,
        app,
        ...(window ? { window } : {}),
        elementId,
        action,
        ...(value !== undefined ? { value } : {}),
      },
      signal,
    );
    if (!result.ok) return refused(result, appOf(app), "ui", target);
    await step(appOf(app), "ui", target, "done");
    // A selection through UI Automation's Select can activate the app's window. The
    // row did get selected, so this is not a refusal, but the model must not be told "Done" for a
    // step the user watched bring the app to the front.
    if (result.note === "brought_window_to_front")
      return {
        text: zh
          ? "已选中，但这一步把应用的窗口带到了前台（原来的前台窗口被切走）。用 ui_tree 核对结果；不需要前台时尽量改用 press 或 keys / Selected, but this step brought the app's window to the front (the window that was in front lost it). Check the result with ui_tree; prefer press or keys when the app does not need to be in front."
          : "Selected, but this step brought the app's window to the front (the window that was in front lost it). Check the result with ui_tree; prefer press or keys when the app does not need to be in front.",
      };
    if (action === "select" && result.effect === "unverified")
      return {
        text: zh
          ? "已执行选择，但无法确认最终选中项与目标一致。先用 ui_tree 核对，不要直接重复选择 / Selection sent; the final selection could not be verified against the target. Check with ui_tree before selecting again."
          : "Selection sent; the final selection could not be verified against the target. Check with ui_tree before selecting again.",
      };
    return {
      text:
        result.effect === "confirmed"
          ? zh
            ? "完成"
            : "Done"
          : zh
            ? "已执行，但无法确认效果，可重读界面树核对 / Sent; the effect could not be confirmed, read the tree to check"
            : "Sent; the effect could not be confirmed. Read the tree to check.",
    };
  }
  if (input.tool === "pointer") {
    const { app, window, ...rest } = input.args;
    // The step view reads coordinate step targets as "x,y" in the screenshot's pixels.
    const target = `${Math.round(rest.x)},${Math.round(rest.y)}`;
    const description = `${rest.kind} ${target}${rest.to ? ` → ${Math.round(rest.to.x)},${Math.round(rest.to.y)}` : ""}`;
    return deliver<"host.computer.pointer">(
      (delivery) =>
        host.call(
          "host.computer.pointer",
          { token, app, ...(window ? { window } : {}), ...rest, delivery },
          signal,
        ),
      appOf(app),
      "coordinates",
      target,
      description,
      context.computerShots?.get(rest.screenshotId),
    );
  }
  if (input.tool === "keys") {
    const { app, window, elementId, text, combo } = input.args;
    const where = elementId ? ` → ${(elements.get(elementId) ?? "element").slice(0, 200)}` : "";
    const target = combo
      ? `${combo.join("+")}${where}`
      : `${zh ? `输入 ${text?.length ?? 0} 个字符` : `type ${text?.length ?? 0} characters`}${where}`;
    let echoed: string | undefined;
    const sent = await deliver<"host.computer.keys">(
      (delivery) =>
        host
          .call(
            "host.computer.keys",
            {
              token,
              app,
              ...(window ? { window } : {}),
              ...(elementId ? { elementId } : {}),
              ...(text !== undefined ? { text } : {}),
              ...(combo ? { combo } : {}),
              delivery,
            },
            signal,
          )
          .then((result) => {
            if (result.ok) echoed = result.focusValue;
            return result;
          }),
      appOf(app),
      "keys",
      target,
    );
    return {
      ...sent,
      text: sent.text + (sent.isError ? "" : focusValueText(echoed, local.deps.redactor)),
    };
  }
  const targetPath = context.runWorkplace?.boundary.location?.platform === "win32" ? win32 : posix;
  // open_app / open_file: the host opens with a fixed argv outside the command sandbox.
  const target =
    input.tool === "open_app"
      ? { kind: "app" as const, name: input.args.app }
      : {
          kind: "file" as const,
          path: context.runWorkplace?.boundary.location?.target.startsWith("runner:")
            ? targetPath.resolve(prepared.cwd, input.args.path)
            : isAbsolute(input.args.path)
              ? input.args.path
              : join(prepared.cwd, input.args.path),
          app: input.args.app,
        };
  const app = appOf(input.args.app);
  const subject =
    input.tool === "open_app"
      ? input.args.app
      : (target as { path: string }).path.split(/[\\/]/).pop();
  const description = `${zh ? "打开" : "open"} ${subject}`;
  // Also stored as data, so Records words it in the UI language rather than the run's.
  const action: ComputerStepAction = {
    kind: input.tool === "open_app" ? "open_app" : "open_file",
    subject: (subject ?? "").slice(0, 300),
  };
  // A file opened in an app is read by that app, so its path passes the same read gate
  // (workplaces, sensitive paths, approval card) as read_file.
  if (target.kind === "file") {
    const approved = await run.approveFile(target.path, signal);
    if (typeof approved === "string") {
      await step(app, "ui", description, "denied", "background", undefined, action);
      return { text: approved, isError: true };
    }
  }
  const opened = await host.call("host.computer.open", { token, target }, signal);
  if (!opened.ok) return refused(opened, app, "ui", description, action);
  await step(app, "ui", description, "done", "background", undefined, action);
  const identity = opened.app
    ? `\n${untrusted}\n${zh ? "实际应用（后续用 id）" : "Observed app (use its id next)"}: ${JSON.stringify(opened.app)}`
    : "";
  return { text: `${zh ? `已打开：${description}` : `Opened: ${description}`}${identity}` };
}
