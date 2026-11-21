import { dirname } from "node:path";
import { ExecError } from "../core/types.ts";
import type { GitHookPlan } from "./git-hook-types.ts";

const snapshotBrand = Symbol("git-hook-snapshot");

/** Execution-internal, per-call evidence. JSON and a user-supplied path cannot create it. */
export interface GitHookSnapshot {
  readonly [snapshotBrand]: true;
}

class SnapshotProof {
  readonly [snapshotBrand] = true as const;
  #plan: GitHookPlan;
  #directory: string;
  #temp: string;
  #check: () => Promise<void>;

  constructor(plan: GitHookPlan, directory: string, temp: string, check: () => Promise<void>) {
    this.#plan = plan;
    this.#directory = directory;
    this.#temp = temp;
    this.#check = check;
    Object.freeze(this);
  }

  static async directory(value: GitHookSnapshot, temp: string) {
    // Private fields survive neither JSON, spreading nor a copied prototype.
    if (!value || typeof value !== "object" || !(#plan in value))
      throw new ExecError("authorization_changed");
    if (
      !value.#plan.claimed ||
      value.#plan.platform !== "linux" ||
      process.platform !== "linux" ||
      value.#temp !== temp ||
      dirname(value.#directory) !== temp
    )
      throw new ExecError("authorization_changed");
    await value.#check();
    return value.#directory;
  }
}

export function createGitHookSnapshot(
  plan: GitHookPlan,
  directory: string,
  temp: string,
  check: () => Promise<void>,
): GitHookSnapshot {
  return new SnapshotProof(plan, directory, temp, check);
}

export async function gitHookSnapshotDirectory(value: GitHookSnapshot, temp: string) {
  return SnapshotProof.directory(value, temp);
}
