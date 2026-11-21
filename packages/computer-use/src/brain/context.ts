import type { ComputerRuntime, ComputerToolRun } from "@pibot/brain/kit";
import type { ComputerGrantService } from "./service/grants/computer-grants.ts";
import type { ComputerHandoffService } from "./service/handoff/computer-handoff.ts";
import type { ComputerSteps } from "./service/steps/computer-steps.ts";
export interface ComputerContext extends ComputerRuntime {
  computerGrants: ComputerGrantService;
  computerSteps: ComputerSteps;
  computerHandoff: ComputerHandoffService;
}
export interface ComputerExecutionRun extends ComputerToolRun {
  local: ComputerContext;
}
