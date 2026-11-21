import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  directoryIdentity,
  type RunCommandOptions,
  SKILL_PYTHON_DOMAINS,
  skillPythonPaths,
  skillPythonWriteRoots,
} from "@pibot/execution";
import type { SkillRuntimeTarget } from "./skill-runtime.ts";

/** Share the application's request construction with the offline profile probe. */
export async function pythonPreparationCommand(input: {
  dataDir: string;
  target: SkillRuntimeTarget;
  preparation: NonNullable<RunCommandOptions["skillPythonPreparation"]>;
  command: string;
  signal: AbortSignal;
}): Promise<RunCommandOptions> {
  const { dataDir, target, preparation, command, signal } = input;
  const paths = skillPythonPaths(dataDir, preparation);
  return {
    command,
    cwd: paths.env,
    rootIdentities: [await directoryIdentity(paths.env)],
    dataDir,
    botHome: join(dataDir, "bots", target.botId, "home"),
    skillGroupId: target.groupId,
    writeRoots: skillPythonWriteRoots(paths, preparation.phase),
    network: { allowAll: false, domains: [...SKILL_PYTHON_DOMAINS] },
    skillPythonPreparation: preparation,
    timeoutSec: 600,
    runId: randomUUID(),
    signal,
  };
}
