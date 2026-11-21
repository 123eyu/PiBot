import { AgentError } from "@pibot/agent";
import type { ComputerRunContext } from "./port.ts";

/** A tool refusal alone cannot stop an SDK tool loop; close the next request at its boundary. */
export function assertComputerProgress(context: ComputerRunContext) {
  if (context.computerProgress?.stopped) throw new AgentError("computer_stalled");
}

export function computerReadingWindow(context: ComputerRunContext) {
  return (context.computerProgress?.reads ?? 0) >= 6 && !context.computerProgress?.stopped;
}
