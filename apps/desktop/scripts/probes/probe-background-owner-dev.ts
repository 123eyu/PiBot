// Narrow private failure injection; the normal directory validation remains real.

import * as actual from "../../../../packages/routines/src/host/dev/dev.ts";
import { ownerProbe } from "./probe-background-owner-electron.ts";
export const routineTestDirectory = actual.routineTestDirectory;
export function registerRoutineDev(options: Parameters<typeof actual.registerRoutineDev>[0]) {
  if (ownerProbe.scenario === "init-fail-child")
    throw new Error("private post-spawn initialization failure");
  return actual.registerRoutineDev(options);
}
