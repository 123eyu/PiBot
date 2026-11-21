import { join } from "node:path";
import { ExecError, type RunCommandOptions } from "../core/types.ts";

/** This recipe is in-process only. No host paths are provided by a skill manifest. */
export const SKILL_PYTHON_DOMAINS = [
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "pypi.org",
  "files.pythonhosted.org",
] as const;

export function skillPythonPaths(
  dataDir: string,
  plan: NonNullable<RunCommandOptions["skillPythonPreparation"]>,
) {
  if (!/^[a-f0-9]{16}$/.test(plan.envId) || !/^\d+\.\d+\.\d+$/.test(plan.uvVersion))
    throw new ExecError("invalid_input");
  return {
    env: join(dataDir, "skill-envs", plan.envId, "venv"),
    python: join(dataDir, "runtimes", "python"),
    // Electron owns <dataDir>/Cache on case-insensitive filesystems; keep uv's cache under
    // runtimes so its canonical path cannot alias that browser-created directory.
    cache: join(dataDir, "runtimes", "uv-cache"),
    uv: join(dataDir, "runtimes", "uv", plan.uvVersion),
  };
}

/** A dependency build never gets write access to the shared base interpreter. */
export function skillPythonWriteRoots(
  paths: ReturnType<typeof skillPythonPaths>,
  phase: "create" | "dependencies" | "verify",
) {
  switch (phase) {
    case "create":
      return [paths.env, paths.python, paths.cache];
    case "dependencies":
      return [paths.env];
    case "verify":
      return [];
    default:
      throw new ExecError("invalid_input");
  }
}
