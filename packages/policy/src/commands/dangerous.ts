import type { CommandAnalysis, CommandInvocation, Platform } from "../core/types.ts";
import { containsPath } from "../paths/paths.ts";

export interface DangerRule {
  id: string;
  matches(
    command: CommandInvocation,
    context: { analysis: CommandAnalysis; roots: string[]; platform: Platform },
  ): boolean;
}
export const DANGEROUS_RULES: readonly DangerRule[] = [
  {
    id: "outside_delete",
    matches: ({ program, args }, { analysis, roots, platform }) =>
      (["rm", "rmdir", "unlink"].includes(program) ||
        (program === "find" && args.includes("-delete")) ||
        (program === "git" && args.includes("clean"))) &&
      analysis.writes.some((path) => !roots.some((root) => containsPath(root, path, platform))),
  },
  {
    id: "outside_permissions",
    matches: ({ program }, { analysis, roots, platform }) =>
      ["chmod", "chown"].includes(program) &&
      analysis.writes.some((path) => !roots.some((root) => containsPath(root, path, platform))),
  },
  {
    id: "remove_workplace_root",
    matches: ({ program, args }, { analysis, roots, platform }) => {
      if (
        program !== "rm" ||
        !args.some((arg) => arg === "--recursive" || /^-[^-]*[rR]/.test(arg)) ||
        !args.some((arg) => arg === "--force" || /^-[^-]*f/.test(arg))
      )
        return false;
      const isRoot = (path: string) =>
        roots.some(
          (root) => containsPath(root, path, platform) && containsPath(path, root, platform),
        );
      // Video dry run 2026-11-20: 「rm -rf tmp」 in a script whose loop moved files was flagged as
      // deleting the whole workplace, because the script's combined writes included the folder
      // itself. Judge this rm by its own operands; only an operand the analysis could not resolve
      // falls back to the script's writes.
      const operands = args.filter(
        (arg, index) => !arg.startsWith("-") || args[index - 1] === "--",
      );
      return operands.some(
        (operand) =>
          /^(?:\.{1,2}\/?|\.?\/?\*|\.\/\.\*|\*\/?)$/.test(operand) ||
          (/^(?:[A-Za-z]:)?[\\/]/.test(operand) && isRoot(operand)) ||
          (/[$`~]/.test(operand) && analysis.writes.some(isRoot)),
      );
    },
  },
  {
    id: "system_settings",
    matches: ({ program, args }) =>
      ["launchctl", "systemctl", "csrutil", "nvram", "scutil", "networksetup", "pmset"].includes(
        program,
      ) ||
      (program === "defaults" && args.includes("write")),
  },
  {
    id: "force_push",
    matches: ({ program, args }) =>
      program === "git" &&
      args.includes("push") &&
      args.some((arg) => /^(--force(?:-with-lease|-if-includes)?(?:=.*)?|-.*f.*)$/.test(arg)),
  },
  {
    id: "hard_remote_reset",
    matches: ({ program, args }) =>
      program === "git" &&
      args.includes("reset") &&
      args.includes("--hard") &&
      args.some((arg) => /^(origin|upstream)\//.test(arg)),
  },
  {
    id: "shutdown",
    matches: ({ program }) => ["shutdown", "reboot", "halt", "poweroff"].includes(program),
  },
  {
    id: "kill_init",
    matches: ({ program, args }) =>
      program === "kill" &&
      args.some((arg) => ["-9", "-KILL", "SIGKILL", "KILL"].includes(arg)) &&
      args.includes("1"),
  },
  {
    id: "killall_without_target",
    matches: ({ program, args }) =>
      program === "killall" && !args.some((arg) => !arg.startsWith("-")),
  },
];
export function dangerousReasons(
  analysis: CommandAnalysis,
  roots: string[],
  platform: Platform,
): string[] {
  const reasons = DANGEROUS_RULES.filter((rule) =>
    analysis.commands.some((command) => rule.matches(command, { analysis, roots, platform })),
  ).map((rule) => rule.id);
  if (
    analysis.programs.some((program) => ["curl", "wget"].includes(program)) &&
    analysis.programs.some((program) => ["sh", "bash", "zsh", "dash"].includes(program))
  )
    reasons.push("download_and_execute");
  return [...new Set(reasons)];
}
