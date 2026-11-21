import { canonicalPath, checkedRoot } from "../core/paths.ts";
import { ExecError } from "../core/types.ts";

export type ProfilePathReason = Extract<ExecError["reason"], `profile_${string}`>;

/** Preserve strict alias rejection while identifying the failed check without logging a path. */
export async function profileRoot(path: string, reason: ProfilePathReason) {
  try {
    return await checkedRoot(path);
  } catch (error) {
    if (error instanceof ExecError && error.code === "outside_workplace")
      throw new ExecError("outside_workplace", reason);
    throw error;
  }
}

export async function profilePath(path: string, cwd: string, reason: ProfilePathReason) {
  const canonical = await canonicalPath(path, cwd);
  if (canonical !== path) throw new ExecError("outside_workplace", reason);
  return canonical;
}
