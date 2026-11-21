import type { executeProcess } from "../command/process.ts";
import type { RunCommandOptions } from "../core/types.ts";
import { verifyWorkspace } from "../sandbox/workspace.ts";
import type { prepareGitInitialization } from "./git-init.ts";

export async function runGitInitialization(
  plan: NonNullable<Awaited<ReturnType<typeof prepareGitInitialization>>>,
  input: RunCommandOptions,
  signal: AbortSignal,
  ports: {
    execute(
      command: string,
      phase: "directories" | "initialize",
      roots: string[],
    ): ReturnType<typeof executeProcess>;
  },
) {
  async function phase(command: string, roots: string[], kind: "directories" | "initialize") {
    await plan.check();
    await verifyWorkspace(input.rootIdentities, signal);
    return ports.execute(command, kind, roots);
  }
  if (plan.setupCommand) {
    const created = await phase(plan.setupCommand, [plan.setupWriteRoot], "directories");
    if (created.exitCode !== 0 || signal.aborted)
      return {
        ...created,
        truncatedOutput: `Git目录准备失败，Git未运行 / Git directory preparation failed; Git was not run.\n${created.truncatedOutput}`,
      };
    await plan.complete();
  }
  const result = await phase(plan.command, [plan.gitDir], "initialize");
  return {
    ...result,
    truncatedOutput: plan.emptyTemplate
      ? `Git初始化使用可信空模板（不安装sample hooks）/ Git init uses an empty template (no sample hooks).\n${result.truncatedOutput}`
      : result.truncatedOutput,
  };
}
