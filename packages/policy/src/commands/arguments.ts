import type { Platform } from "../core/types.ts";
import { type ArgumentFacts, countShorthand, optionFacts } from "./argument-types.ts";
import { findFacts } from "./find-actions.ts";
import { gitFacts } from "./git.ts";
import { FILE_OPTIONS, type OptionSpec, parseOptions } from "./options/options.ts";
import { otherFacts, otherOptions } from "./options/other-options.ts";
import { readonlyOptions } from "./options/program-options.ts";
import { pathArguments } from "./path-arguments.ts";
import { sedFacts } from "./sed.ts";
import { systemArguments } from "./system-arguments.ts";

/** One semantic result is used by both the approval facts and the readonly decision. */
export function analyzeArguments(
  program: string,
  args: string[],
  platform: Platform,
): ArgumentFacts {
  let result: ArgumentFacts;
  if (program === "git") result = gitFacts(args);
  else if (program === "find") result = findFacts(args);
  else if (program === "sed") result = sedFacts(args, platform);
  else if (SHELL_BUILTINS.has(program)) result = builtinFacts(program, args);
  else
    result =
      systemArguments(program, args, platform) ??
      pathArguments(program, args) ??
      simpleArguments(program, args, platform);
  // 12a.2 keeps known mutators ask-only, even when their options are fully understood.
  if (!result.readonly || result.unknownOptions.length) result.incomplete = true;
  return result;
}
/**
 * The builtins nearly every script uses. None opens a file or the network; `[`/`test`
 * only look at the files they test (recorded as reads). Anything outside the plain forms below is
 * not read-only and stays an ask.
 */
const SHELL_BUILTINS = new Set([
  "set",
  "exit",
  "return",
  "true",
  "false",
  ":",
  "[",
  "test",
  "printf",
]);
const FILE_TESTS = new Set("-e -f -d -r -w -x -s -L -h -p -S -b -c -g -u -k -O -G -N".split(" "));
function builtinFacts(program: string, args: string[]): ArgumentFacts {
  const result = optionFacts(parseOptions([], {}));
  if (program === "set")
    result.readonly = args.every(
      (arg, i) =>
        /^[-+][euxvnfaCBEHhmT]+$/u.test(arg) ||
        (["-o", "+o"].includes(args[i - 1] ?? "") &&
          ["pipefail", "errexit", "nounset", "xtrace", "noclobber", "noglob"].includes(arg)) ||
        arg === "-o" ||
        arg === "+o",
    );
  else if (program === "exit" || program === "return")
    result.readonly = args.length <= 1 && args.every((arg) => /^\d{1,3}$/u.test(arg));
  else if (program === "[" || program === "test") {
    const body = program === "[" ? (args.at(-1) === "]" ? args.slice(0, -1) : undefined) : args;
    if (!body) result.readonly = false;
    else
      for (let i = 0; i < body.length; i++)
        if (FILE_TESTS.has(body[i] ?? "") && body[i + 1] !== undefined)
          result.reads.push(body[++i] as string);
  } else if (program === "printf") {
    // `printf -v name` only sets a shell variable; any other option is not understood. The name
    // must be a literal identifier: a dynamic one (an empty word here) could be any variable,
    // PATH or one a script substitution relied on (security review N1).
    result.readonly =
      args[0] !== "" &&
      (args[0] !== "-v" || /^[A-Za-z_]\w*$/u.test(args[1] ?? "")) &&
      args.every(
        (arg, i) =>
          !arg.startsWith("-") ||
          (arg === "-v" && i === 0) ||
          arg === "--" ||
          args[i - 1] === "-v" ||
          i > 0,
      );
  }
  return result;
}
function simpleArguments(program: string, rawArgs: string[], platform: Platform): ArgumentFacts {
  // echo prints every argument, dashes included (`echo ---`); it never opens a file.
  if (program === "echo") return optionFacts(parseOptions([], {}));
  const args = program === "head" || program === "tail" ? countShorthand(rawArgs) : rawArgs;
  let spec: OptionSpec | undefined =
    program === "file"
      ? FILE_OPTIONS
      : Object.hasOwn(readonlyOptions, program)
        ? readonlyOptions[program]
        : undefined;
  if (program === "stat" && platform === "darwin")
    spec = { flags: "FLnqrx", values: "ft", longFlags: [] };
  const parsed = parseOptions(
    args,
    spec ?? (Object.hasOwn(otherOptions, program) ? otherOptions[program] : undefined) ?? {},
  );
  const result = optionFacts(parsed);
  if (!spec) return otherFacts(result, program, args, parsed);
  const operands = parsed.operands.filter((arg) => arg !== "");
  if (program === "grep" || program === "rg") {
    const explicit =
      ["-e", "-f", "--regexp", "--file"].some((key) => parsed.values.has(key)) ||
      parsed.flags.has("--files");
    const paths = operands.slice(explicit ? 0 : 1);
    result.reads.unshift(...paths);
    if (
      !paths.length &&
      (program === "rg" ||
        parsed.flags.has("-r") ||
        parsed.flags.has("-R") ||
        parsed.flags.has("--recursive") ||
        parsed.flags.has("--dereference-recursive"))
    )
      result.reads.unshift(".");
  } else if (program === "sleep") {
    const duration = /^(?:\d+(?:\.\d*)?|\.\d+)[smhd]?$/;
    if (
      operands.some(
        (arg) => !duration.test(arg) || !Number.isFinite(Number(arg.replace(/[smhd]$/, ""))),
      ) ||
      (!operands.length && !parsed.flags.has("--help") && !parsed.flags.has("--version"))
    )
      result.readonly = false;
  } else if (!["echo", "pwd", "which"].includes(program)) {
    result.reads.unshift(...operands);
    if (
      !operands.length &&
      args.every((arg) => arg.startsWith("-")) &&
      !["cat", "head", "tail", "wc", "file"].includes(program)
    )
      result.reads.unshift(".");
  }
  if (program === "file") {
    if (parsed.flags.has("-C") || parsed.flags.has("--compile")) result.writes.push(".");
    if (parsed.flags.has("-p") || parsed.flags.has("--preserve-date"))
      result.writes.push(...operands);
    // File lists can introduce further paths that cannot be known without opening their contents.
    if (parsed.values.has("-f") || parsed.values.has("--files-from")) result.incomplete = true;
  }
  return result;
}
