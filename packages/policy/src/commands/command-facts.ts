import type { CommandAnalysis, CommandInvocation, Platform } from "../core/types.ts";
import type { ArgumentFacts } from "./argument-types.ts";
import { analyzeArguments } from "./arguments.ts";
import { isOutputTarget } from "./output-targets.ts";
export function emptyAnalysis(): CommandAnalysis {
  return {
    programs: [],
    commands: [],
    reads: [],
    writes: [],
    domains: [],
    network: false,
    incomplete: false,
    warnings: [],
    unknownOptions: [],
    readonly: false,
  };
}
export function uncertain(result: CommandAnalysis, reason: string) {
  result.incomplete = true;
  if (!result.warnings.includes(reason)) result.warnings.push(reason);
}
/** `cd <dir>` validated by the caller: reads only the directory it enters. */
export function addDirectoryChange(result: CommandAnalysis, directory: string) {
  result.programs.push("cd");
  result.commands.push({ program: "cd", args: [directory] });
  result.readonly = result.commands.length === 1 ? true : result.readonly;
  result.reads.push(directory);
}
export function addCommand(
  result: CommandAnalysis,
  program: string,
  args: string[],
  platform: Platform,
): ArgumentFacts {
  const command: CommandInvocation = { program, args };
  const facts = analyzeArguments(program, args, platform);
  result.programs.push(program);
  result.commands.push(command);
  result.readonly =
    result.commands.length === 1 ? facts.readonly : result.readonly && facts.readonly;
  result.reads.push(...facts.reads.filter((path) => path !== "-"));
  // Metadata operations (rm/chmod/mv) still must not modify device nodes.
  const outputOnly = ["curl", "wget", "tee", "dd"].includes(program);
  result.writes.push(
    ...facts.writes.filter(
      (path) => path !== "-" && !(outputOnly && isOutputTarget(path, platform)),
    ),
  );
  result.domains.push(...facts.domains);
  result.unknownOptions.push(...facts.unknownOptions);
  result.network ||= facts.network;
  if (facts.incomplete) uncertain(result, "unknown_or_mutating_program");
  if (facts.unknownOptions.length) uncertain(result, "unknown_option");
  return facts;
}
