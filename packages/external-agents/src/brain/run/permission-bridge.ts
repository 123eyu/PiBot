// ACP `session/request_permission` → Pi Bot's own gate. The agent's request
// is judged as the Pi Bot tool it resembles, so permission levels, remembered grants, YOLO limits,
// danger rules, the approval card and the audit all apply unchanged. Pi Bot only answers; the
// agent performs the action itself, inside its outer sandbox (none on Windows).
import { isAbsolute } from "node:path";
import type { RequestPermissionParams, ToolKind } from "@pibot/acp-schemas";
import type { LocalToolCall } from "@pibot/agent";
import {
  askForUnmappedAction,
  auditText,
  authorizeDelegatedAction,
  type DelegatedDecision,
  type LocalService,
  type ToolRunContext,
} from "@pibot/brain/kit";
import { BRIDGE_TOOLS } from "../bridge/bridge-tools.ts";
import { maskAccount } from "../privacy/account-mask.ts";

type Requested = RequestPermissionParams["toolCall"];

const string = (value: unknown) => (typeof value === "string" && value ? value : undefined);
const field = (input: unknown, ...names: string[]) => {
  if (!input || typeof input !== "object") return undefined;
  for (const name of names) {
    const value = string((input as Record<string, unknown>)[name]);
    if (value) return value;
  }
  return undefined;
};

/** The command an agent asked to run: Claude sends a string, Codex an argv (often `sh -lc …`). */
function commandOf(toolCall: Requested): string | undefined {
  const raw = toolCall.rawInput as Record<string, unknown> | undefined;
  const command = raw?.command ?? raw?.cmd;
  if (typeof command === "string" && command.trim()) return command;
  if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
    const argv = command as string[];
    if (argv.length === 3 && /(^|\/)(ba|z)?sh$/.test(argv[0] ?? "") && /^-l?c$/.test(argv[1] ?? ""))
      return argv[2];
    return argv
      .map((part) => (/^[\w./=:@%+-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`))
      .join(" ");
  }
  return undefined;
}

function pathsOf(toolCall: Requested): string[] {
  const located = (toolCall.locations ?? []).map((location) => location.path);
  const named = [
    field(toolCall.rawInput, "file_path", "filePath", "path", "notebook_path"),
    // A move writes its destination too (security review: judge both ends).
    ...(toolCall.kind === "move"
      ? [field(toolCall.rawInput, "new_path", "newPath", "destination", "target", "to")]
      : []),
  ].filter((path): path is string => !!path && isAbsolute(path));
  return [...new Set([...located, ...named])].slice(0, 8);
}

/** Audit reason of an agent's ask to call a Pi Bot bridge tool, answered without a card. */
export const PIBOT_BRIDGE_GATED = "pibot_bridge_gated";
const CHANGES = new Set<ToolKind>(["execute", "edit", "delete", "move"]);
const PIBOT_TITLE = /^mcp(?:\.|__)pibot(?:\.|__)([a-z_]{1,64})$/;

/**
 * The Pi Bot bridge tool an agent's step is a call of, as agents name their MCP calls
 * (Codex: rawInput `{ server, tool }` and title `mcp.pibot.<tool>`; Claude: `mcp__pibot__<tool>`).
 */
export function pibotTool(toolCall: {
  title?: string | null;
  kind?: ToolKind | null;
  rawInput?: unknown;
  _meta?: unknown;
}) {
  const raw = toolCall.rawInput as { server?: unknown; tool?: unknown } | null | undefined;
  const fromRaw =
    raw && typeof raw === "object" && raw.server === "pibot" && typeof raw.tool === "string"
      ? raw.tool
      : undefined;
  // Codex reports every MCP call as kind "execute"; its adapter marks them in `_meta`, which the
  // model cannot write. Without that marker the title and rawInput are the only clues, so a step
  // that is a command or file change is never taken for a bridge call (it keeps its own card).
  const named = mcpMarked(toolCall._meta, "is_mcp_tool_call")
    ? fromRaw
    : toolCall.kind && CHANGES.has(toolCall.kind)
      ? undefined
      : (fromRaw ?? PIBOT_TITLE.exec(toolCall.title ?? "")?.[1]);
  return named && BRIDGE_TOOLS.has(named) ? named : undefined;
}

function mcpMarked(meta: unknown, key: "is_mcp_tool_call" | "is_mcp_tool_approval") {
  return !!meta && typeof meta === "object" && (meta as Record<string, unknown>)[key] === true;
}

/** Pi Bot tool calls that stand for this request; empty means "no policy to judge it by". */
export function mappedCalls(toolCall: Requested, cwd: string): Omit<LocalToolCall, "id">[] {
  const kind: ToolKind = toolCall.kind ?? "other";
  if (kind === "execute") {
    const command = commandOf(toolCall);
    return command
      ? [{ tool: "run_command", input: { command: command.slice(0, 100_000), cwd } }]
      : [];
  }
  if (kind === "edit" || kind === "delete" || kind === "move")
    return pathsOf(toolCall).map((path) => ({ tool: "write_file", input: { path, content: "" } }));
  if (kind === "read")
    return pathsOf(toolCall).map((path) => ({ tool: "read_file", input: { path } }));
  if (kind === "search") {
    const paths = pathsOf(toolCall);
    return (paths.length ? paths : [cwd]).map((path) => ({ tool: "list_dir", input: { path } }));
  }
  if (kind === "fetch") {
    const url = field(toolCall.rawInput, "url", "uri");
    return url ? [{ tool: "web_fetch", input: { url: url.slice(0, 32_768) } }] : [];
  }
  return [];
}

export interface PermissionScope {
  local: LocalService;
  context: ToolRunContext;
  agentName: string;
  cwd: string;
  unisolated: boolean;
  /** The run that handed this work over; its topic shows the cards. */
  cardContext?: ToolRunContext;
  /** This turn's steps that call Pi Bot's own bridge tools, by tool call id. */
  bridgeCalls?: ReadonlyMap<string, string>;
  beforeWrite?: (path: string) => Promise<void>;
  audit(decision: DelegatedDecision, kind: ToolKind, mapped: boolean): void;
}

/**
 * The agent's option for Pi Bot's answer. "Always" is picked only after a person approved a card
 * that said so (an agent offering no "once" option): Pi Bot never hands out lasting permission
 * inside the agent on its own.
 */
export function chooseOption(params: RequestPermissionParams, allowed: boolean) {
  const order = allowed
    ? (["allow_once", "allow_always"] as const)
    : (["reject_once", "reject_always"] as const);
  for (const kind of order) {
    const option = params.options.find((item) => item.kind === kind);
    if (option) return { outcome: { outcome: "selected", optionId: option.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

export async function answerPermission(
  scope: PermissionScope,
  params: RequestPermissionParams,
  signal: AbortSignal,
) {
  const { local, context } = scope;
  const toolCall = params.toolCall;
  const kind: ToolKind = toolCall.kind ?? "other";
  const title = auditText(maskAccount(toolCall.title ?? ""), local.deps.redactor, 300);
  const id = `acp-${toolCall.toolCallId}`.slice(0, 200);
  const cardTitle = (language: "zh" | "en") =>
    language === "zh"
      ? `${scope.agentName} 请求：${title || "执行一个操作"}`
      : `${scope.agentName} asks: ${title || "to perform an action"}`;
  // The agent asks before calling one of Pi Bot's own tools (Codex asks for every MCP call).
  // That call reaches Pi Bot's own gate in the bridge, which decides it with the same policy,
  // card and audit as Pi Bot's Bots; asking here too would show the person two cards for one step.
  if (
    pibotTool(toolCall) ||
    (scope.bridgeCalls?.has(toolCall.toolCallId) &&
      // Codex's MCP approval names only the call id; its adapter's marker says it is one.
      (mcpMarked(params._meta, "is_mcp_tool_approval") || !CHANGES.has(toolCall.kind ?? "other")))
  ) {
    scope.audit({ allowed: true, reason: PIBOT_BRIDGE_GATED }, kind, true);
    return chooseOption(params, true);
  }
  const calls = mappedCalls(toolCall, scope.cwd);
  // An agent offering only "always allow" asks for lasting permission inside itself: that is a
  // person's decision, never Pi Bot's policy or YOLO.
  const alwaysOnly =
    !params.options.some((option) => option.kind === "allow_once") &&
    params.options.some((option) => option.kind === "allow_always");
  const ask = () =>
    askForUnmappedAction(
      local,
      context,
      { id, tool: "external_agent", input: {} },
      {
        signal,
        title: cardTitle,
        detail: alwaysOnly
          ? `${title} · ${scope.agentName} will remember this permission itself`
          : title,
        ...(scope.cardContext ? { cardContext: scope.cardContext } : {}),
      },
    );
  let decision: DelegatedDecision = { allowed: true, reason: "no_action" };
  try {
    if (!calls.length || alwaysOnly) decision = await ask();
    else
      for (const [index, call] of calls.entries()) {
        decision = await authorizeDelegatedAction(
          local,
          context,
          { ...call, id: calls.length > 1 ? `${id}-${index}` : id },
          {
            unisolated: scope.unisolated,
            signal,
            title: cardTitle,
            ...(scope.cardContext ? { cardContext: scope.cardContext } : {}),
          },
        );
        if (!decision.allowed) break;
      }
  } catch {
    // Fail closed: nothing below may leave an earlier "allowed" standing.
    decision = { allowed: false, reason: "authorization_failed" };
    try {
      // An input Pi Bot's tool schema rejects (odd path, huge command) still reaches a person.
      if (!signal.aborted) decision = await ask();
    } catch {
      // Stopped while the card was open: handled below.
    }
    if (signal.aborted) {
      // Stop while the card was open: tell the agent the request was cancelled, and keep the row.
      scope.audit({ allowed: false, reason: "stopped" }, kind, calls.length > 0);
      return { outcome: { outcome: "cancelled" } };
    }
  }
  if (decision.allowed && scope.beforeWrite)
    for (const call of calls)
      if (call.tool === "write_file" && typeof call.input.path === "string")
        await scope.beforeWrite(call.input.path).catch(() => {
          // Bookkeeping cannot grant or revoke the already decided permission.
          local.deps.logger.warn("External agent before-image unavailable");
        });
  scope.audit(decision, kind, calls.length > 0);
  return chooseOption(params, decision.allowed);
}
