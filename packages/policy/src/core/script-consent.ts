import type { GrantScope } from "@pibot/protocol-base";
import { NESTED_SCRIPT } from "../commands/invocations.ts";
import { scriptLoadsCode } from "../commands/script-loads.ts";
import { loadsOtherCode, scriptRun } from "../commands/scripts.ts";
import type { CommandAnalysis } from "./types.ts";

type ProgramsScope = Extract<GrantScope, { kind: "programs" }>;
const SCRIPT = "script:";
const SCRIPT_FILE = "script-file:";

/**
 * Incompleteness that comes from what the script's commands do, not from which code runs: an
 * unknown program or option, a dynamic argument. Anything that makes the code itself depend on
 * data (a dynamic program or shell text, a nested script, a parse failure) is not on this list.
 */
const PINNABLE_WARNINGS = new Set([
  "unknown_or_mutating_program",
  "unknown_option",
  "dynamic_argument",
  "dynamic_redirect",
  "descriptor_redirect",
  "environment_assignment",
  "unknown_directory_write",
  "unsupported_directory_change",
  "wrapper_options",
  "find_action_cwd_unknown",
]);
// Builtins that run text or another file in place of the script's own commands.
const SOURCING = new Set(["source", ".", "eval", "exec"]);

/**
 * A routine may pre-authorize a script policy read but could not
 * prove, pinned to that exact text and its arguments (`script:<digest>`), the file as written and
 * the directory it ran in. A changed script has another digest, so the old consent no longer
 * matches and the routine asks again. Chats are unaffected: this never becomes a remembered grant.
 *
 * Not pinned: code the script loads at run time from elsewhere (other scripts, modules, a
 * Makefile or package.json a program it calls reads). Where policy can see that (another
 * interpreter run, `source`, `eval`, a dynamic program) no scope is offered and the run keeps
 * asking; what it cannot see stays bounded by the sandbox the run executes in.
 */
export function scriptPreauthScope(
  analysis: CommandAnalysis,
  cwd: string,
): ProgramsScope | undefined {
  const tokens = analysis.programs.filter((program) => program.startsWith(SCRIPT));
  const file = analysis.scriptFiles?.[0];
  if (tokens.length !== 1 || !file || analysis.scriptFiles?.length !== 1) return undefined;
  if (analysis.warnings.some((warning) => !PINNABLE_WARNINGS.has(warning))) return undefined;
  if (analysis.warnings.includes(NESTED_SCRIPT)) return undefined;
  // The run's own interpreter call (`python3 tool.py`) names the pinned file itself.
  const own = (command: { program: string; args: string[] }) => {
    const run = scriptRun(command.program, command.args);
    return run?.kind === "file" && run.path === file;
  };
  // Inline code inside the script (`node -e 'require("./lib")'`) is part of the pinned text,
  // but what it loads is not; inline Python also imports from the cwd unless run with -I.
  const loadsInline = (program: string, args: readonly string[]) => {
    const run = scriptRun(program, args);
    return run?.kind === "inline" && scriptLoadsCode(run.language, run.code, run.safePath === true);
  };
  const loads = analysis.commands.filter(
    ({ program, args }) =>
      SOURCING.has(program) || loadsOtherCode(program, args) || loadsInline(program, args),
  );
  if (loads.some((command, index) => index > 0 || !own(command))) return undefined;
  return { kind: "programs", programs: [tokens[0] as string, `${SCRIPT_FILE}${file}`], root: cwd };
}

/** A scope made by `scriptPreauthScope`: it names one script and nothing else. */
export function scriptPinnedScope(programs: readonly string[]) {
  return (
    programs.some((program) => program.startsWith(SCRIPT)) &&
    programs.every((program) => program.startsWith(SCRIPT) || program.startsWith(SCRIPT_FILE))
  );
}
export function pinnedScriptFile(programs: readonly string[]) {
  return programs.find((program) => program.startsWith(SCRIPT_FILE));
}
