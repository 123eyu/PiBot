import { isSafeSecretEnvName } from "@pibot/execution";
import {
  type BrowserRequest,
  type BrowserSecretUse,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol-base";
import type { RunCommandArgs } from "@pibot/tools/command";
import type { PreparedTool, ToolRunContext } from "../../../core/local-types.ts";
import type { LocalService } from "../../../local-service.ts";
import type { ToolInput } from "../tools.ts";

const refused = () => new RpcError(RpcErrorCodes.invalidParams, "secret_handle_refused");
const markers = (value: unknown) => JSON.stringify(value)?.includes("«secret:") === true;

/** Metadata only during preparation: the model cannot choose a false source label for its card. */
export async function prepareBrowserSecrets(
  local: LocalService,
  context: ToolRunContext,
  input: ToolInput,
  signal: AbortSignal,
  executionTarget?: string,
): Promise<BrowserSecretUse[]> {
  if (input.tool === "browser_secret") return [];
  let uses: { handle: string; destination: string }[] = [];
  if (input.tool === "run_command" && input.args.env) {
    const { env, ...rest } = input.args as RunCommandArgs;
    if (!env) throw refused();
    if (
      markers(rest) ||
      rest.background ||
      rest.docker ||
      rest.outsideSandbox ||
      rest.command.length > 3000 ||
      (executionTarget ??
        context.runWorkplace?.boundary.location?.target ??
        local.deps.executionLocation?.target ??
        "local") !== "local" ||
      context.executionDevice ||
      (local.deps.executionLocation !== undefined &&
        local.deps.executionLocation.target !== "local")
    )
      throw refused();
    uses = Object.entries(env).map(([name, handle]) => {
      if (!isSafeSecretEnvName(name)) throw refused();
      return { handle, destination: `env ${name} for command ${rest.command}` };
    });
  } else if (input.tool === "browser_request") {
    const { headers, body, ...rest } = input.args as BrowserRequest;
    if (markers(rest)) throw refused();
    const add = (text: string, destination: string) => {
      const handles = text.match(/«secret:h[a-f0-9]{32}»/g) ?? [];
      if (text.replace(/«secret:h[a-f0-9]{32}»/g, "").includes("«secret:")) throw refused();
      uses.push(...handles.map((handle) => ({ handle, destination })));
    };
    for (const [name, value] of Object.entries(headers ?? {})) {
      if (markers(name)) throw refused();
      add(value, `header ${name} to ${rest.origin}`);
    }
    if (body !== undefined) add(body, `body to ${rest.origin}`);
  } else if (markers(input.args)) throw refused();
  if (!uses.length) return [];
  const host = local.browser.forContext(context).host;
  if (!host || uses.length > 32) throw refused();
  const described = await host.call(
    "host.browser.secretUses",
    {
      botId: context.botId,
      runId: context.runId,
      uses,
      ...(input.tool === "browser_request"
        ? { tab: input.args.tab, origin: input.args.origin }
        : {}),
    },
    signal,
  );
  return described.uses;
}

/** Values exist only in this adapter and the execution env; no caller may return them as text. */
export async function commandHandleEnvironment(
  local: LocalService,
  context: ToolRunContext,
  prepared: PreparedTool,
  signal: AbortSignal,
) {
  const uses = prepared.browserSecretUses ?? [];
  if (
    !prepared.confirmedNow ||
    !uses.length ||
    prepared.call.tool !== "run_command" ||
    prepared.docker ||
    prepared.gitConfiguration ||
    prepared.gitHook ||
    prepared.gitEntries?.plan ||
    prepared.hostSsh ||
    (local.deps.executionLocation !== undefined &&
      local.deps.executionLocation.target !== "local") ||
    (prepared.boundary?.location?.target !== undefined &&
      prepared.boundary.location.target !== "local")
  )
    throw refused();
  const values = await consumeBrowserSecrets(local, context, prepared, signal);
  const args = prepared.call.input.env as Record<string, string>;
  const byHandle = new Map(values.map(({ handle, value }) => [handle, value]));
  const env: Record<string, string> = {};
  for (const [name, handle] of Object.entries(args)) {
    const value = byHandle.get(handle);
    if (!value || !isSafeSecretEnvName(name)) throw refused();
    env[name] = value;
  }
  for (const use of uses)
    local.approvals.audit.append({
      botId: context.botId,
      runId: context.runId,
      kind: "exec.started",
      summary: "Secret handle used / 使用秘密句柄",
      detail: {
        actor: "automatic",
        toolName: "run_command",
        target: use.destination,
        domain: use.site,
        reason: `${use.kind}: ${use.name}`,
      },
    });
  return { env, values };
}

/** Defense registration is internal only and shares the same per-call consent as substitution. */
export async function consumeBrowserSecrets(
  local: LocalService,
  context: ToolRunContext,
  prepared: PreparedTool,
  signal: AbortSignal,
) {
  const uses = prepared.browserSecretUses ?? [];
  if (
    !prepared.confirmedNow ||
    !uses.length ||
    !["browser_request", "run_command"].includes(prepared.call.tool)
  )
    throw refused();
  const host = local.browser.forContext(context).host;
  if (!host) throw refused();
  const { values } = await host.call(
    "host.browser.consumeSecrets",
    { botId: context.botId, runId: context.runId, uses },
    signal,
  );
  try {
    for (const { value, handle } of values)
      local.deps.redactor.addNamed("BROWSER_SECRET", value, handle);
  } catch {
    // A failed/budget-exhausted defense registration refuses dispatch, never echoes the value.
    throw new RpcError(RpcErrorCodes.invalidParams, "secret_redaction_budget_exceeded");
  }
  return values;
}

/** Recheck after sandbox/environment setup, immediately before the child's dispatch. */
export async function validateCommandHandles(
  local: LocalService,
  context: ToolRunContext,
  prepared: PreparedTool,
  signal: AbortSignal,
) {
  const host = local.browser.forContext(context).host;
  const uses = prepared.browserSecretUses;
  if (!host || !prepared.confirmedNow || !uses?.length) throw refused();
  const current = await host.call(
    "host.browser.secretUses",
    {
      botId: context.botId,
      runId: context.runId,
      uses: uses.map(({ handle, destination }) => ({ handle, destination })),
    },
    signal,
  );
  if (JSON.stringify(current.uses) !== JSON.stringify(uses)) throw refused();
}
