import { mutatingOptions } from "../commands/options/mutating-options.ts";
import { readonlyOptions } from "../commands/options/program-options.ts";
import { isReadonlyCommand, READONLY_PROGRAMS } from "../commands/readonly-programs.ts";
import { containsPath } from "../paths/paths.ts";
import { explainPolicyResult } from "./explain.ts";
import type { CommandInvocation, Platform, PolicyResult } from "./types.ts";

/** Isolation reason of an ACP editor terminal; also the card warning naming it. */
export const EDITOR_TERMINAL_UNISOLATED = "acp_editor_terminal_unisolated";
/** A read-only command inside the session's folders at the "always" level: run without a card. */
export const EDITOR_TERMINAL_READONLY_REASON = "editor_terminal_readonly";
/** The person chose "allow for this session" for this command shape earlier in the session. */
export const EDITOR_SESSION_REASON = "editor_session_allowed";
const SESSION_FACT = "editor_session_rememberable";

/**
 * Programs whose arguments the analyzer fully understands. Shells, interpreters and network or
 * remote-sync tools stay out: their effect is not visible in their argument shape.
 */
const SESSION_PROGRAMS: ReadonlySet<string> = new Set([
  ...READONLY_PROGRAMS,
  ...Object.keys(readonlyOptions),
  ...Object.keys(mutatingOptions).filter((program) => program !== "rsync"),
  "cd",
  "find",
  "sed",
  "npm",
  "pnpm",
]);
/** Analysis warnings that only say "this program changes files", which a person may accept. */
const SESSION_WARNINGS: ReadonlySet<string> = new Set(["unknown_or_mutating_program"]);

function inside(roots: readonly string[], path: string, platform: Platform) {
  return roots.some((root) => containsPath(root, path, platform));
}
function background(result: PolicyResult) {
  return result.facts.some(
    (fact) => fact.kind === "warning" && fact.value === "background_command",
  );
}

/** Proven read-only, no network, every path (and the cwd) inside the session's folders. */
export function editorTerminalReadonly(
  result: PolicyResult,
  roots: readonly string[],
  platform: Platform,
): boolean {
  const analysis = result.analysis;
  return (
    result.risk === "normal" &&
    !!analysis &&
    analysis.readonly &&
    !analysis.incomplete &&
    !analysis.network &&
    !analysis.writes.length &&
    !result.outsideWrites?.length &&
    !!result.cwd &&
    inside(roots, result.cwd, platform) &&
    analysis.reads.every((path) => inside(roots, path, platform)) &&
    !background(result)
  );
}

function optionShape(args: readonly string[]) {
  const options = args
    .filter((arg) => arg.startsWith("-") && arg !== "-" && arg !== "--")
    .map((arg) => arg.replace(/=[\s\S]*$/, "").replace(/^-\d+$/, "-N"));
  return [...new Set(options)].sort();
}
/**
 * Read-only invocations are re-proven read-only and in-folder on every call, so their operands
 * (patterns, files) may vary; anything that changes files must repeat its exact arguments.
 */
function invocationShape(command: CommandInvocation, platform: Platform) {
  return command.program === "cd" || isReadonlyCommand(command, platform)
    ? [command.program, ...optionShape(command.args)]
    : [command.program, ...command.args];
}

/**
 * The "program + argument shape" a person may allow for the rest of one ACP session, or
 * undefined when the command must ask every time: a path outside the session's folders, network,
 * an unrecognized program, a file redirect, a pipe into a shell, privilege escalation, command
 * substitution or any other dynamic shell content.
 */
export function editorSessionShape(
  result: PolicyResult,
  roots: readonly string[],
  platform: Platform,
): string | undefined {
  const analysis = result.analysis;
  if (
    !analysis ||
    result.risk !== "normal" ||
    analysis.network ||
    analysis.fileRedirect ||
    !analysis.commands.length ||
    analysis.unknownOptions.length ||
    analysis.warnings.some((warning) => !SESSION_WARNINGS.has(warning)) ||
    result.outsideWrites?.length ||
    result.secretUses?.length ||
    !result.cwd ||
    !inside(roots, result.cwd, platform) ||
    ![...analysis.reads, ...analysis.writes].every((path) => inside(roots, path, platform)) ||
    background(result) ||
    !analysis.commands.every((command) => SESSION_PROGRAMS.has(command.program))
  )
    return undefined;
  return JSON.stringify(analysis.commands.map((command) => invocationShape(command, platform)));
}

function permissionLevel(result: PolicyResult) {
  return result.explanation.findLast(
    (step) => step.axis === "level" && step.code === "permission_level",
  )?.level;
}

/**
 * Owner decision 2026-11-01: an ACP editor terminal cannot attest to isolation. Read-only commands
 * inside the session's folders follow the Bot's run_command level ("always" runs them, "ask"
 * asks); every other command asks. A card may offer "allow for this session" by shape; nothing
 * here is ever a persistent grant. Idempotent: brain re-applies it after re-preparing a call.
 */
export function applyEditorTerminal(
  result: PolicyResult,
  scope: { roots: readonly string[]; platform: Platform; sessionShapes: ReadonlySet<string> },
): PolicyResult {
  if (result.decision === "deny") return result;
  const shape = editorSessionShape(result, scope.roots, scope.platform);
  const warned = (value: string) =>
    result.facts.some((fact) => fact.kind === "warning" && fact.value === value);
  const facts = [
    // A session choice is offered, so "cannot be remembered" would contradict the card.
    ...result.facts.filter(
      (fact) => !(shape && fact.kind === "warning" && fact.value === "incomplete_analysis"),
    ),
    ...(warned(EDITOR_TERMINAL_UNISOLATED)
      ? []
      : [{ kind: "warning" as const, value: EDITOR_TERMINAL_UNISOLATED, risk: "danger" as const }]),
    ...(shape && !warned(SESSION_FACT) ? [{ kind: "warning" as const, value: SESSION_FACT }] : []),
  ];
  const { editorSessionShape: _previous, ...rest } = result;
  const base = {
    ...rest,
    facts,
    canRemember: false,
    ...(shape ? { editorSessionShape: shape } : {}),
  };
  if (
    editorTerminalReadonly(result, scope.roots, scope.platform) &&
    permissionLevel(result) === "always"
  )
    return explainPolicyResult(
      { ...base, decision: "allow", reason: EDITOR_TERMINAL_READONLY_REASON },
      "boundary",
      EDITOR_TERMINAL_READONLY_REASON,
    );
  if (shape && scope.sessionShapes.has(shape))
    return explainPolicyResult(
      { ...base, decision: "allow", reason: EDITOR_SESSION_REASON },
      "grant",
      EDITOR_SESSION_REASON,
    );
  // Skipping the card for read-only commands at "ask" is safe only because the sandbox backs it.
  const reason =
    result.reason === "readonly_command"
      ? "permission_ask"
      : result.decision === "allow"
        ? EDITOR_TERMINAL_UNISOLATED
        : result.reason;
  return explainPolicyResult(
    { ...base, decision: "ask", reason },
    "boundary",
    EDITOR_TERMINAL_UNISOLATED,
  );
}
