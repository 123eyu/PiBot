import type { CommandInvocation, Platform } from "../core/types.ts";
import { analyzeArguments } from "./arguments.ts";

export const READONLY_PROGRAMS = [
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "find",
  "file",
  "stat",
  "du",
  "df",
  "which",
  "echo",
  "pwd",
  "date",
  "cal",
  "uname",
  "sw_vers",
  "whoami",
  "sleep",
  "git",
] as const;
export function isReadonlyCommand(
  command: CommandInvocation,
  platform: Platform = "linux",
): boolean {
  const facts = analyzeArguments(command.program, command.args, platform);
  return facts.readonly && !facts.incomplete && !facts.unknownOptions.length;
}
