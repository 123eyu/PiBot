import type { RegisterRpc } from "@pibot/brain/kit";
import type { ComputerContext } from "../../context.ts";

/**
 * Operation steps for the chat tool steps and the sidebar record. Lists carry only
 * references; screenshots are fetched one at a time, a thumbnail first and the full image only
 * on "click to see larger", so large data never rides the step list or events.
 */
export function registerComputerStepsRpc(handle: RegisterRpc, local: ComputerContext) {
  const signal = (ms: number) => AbortSignal.any([local.shutdown.signal, AbortSignal.timeout(ms)]);
  handle("computer.steps", async ({ botId, runId, groupId, from, before, limit }) =>
    local.computerSteps.repo.list(
      { botId, runId, groupId, from },
      { ...(before ? { before } : {}), ...(limit ? { limit } : {}) },
    ),
  );
  handle("computer.screenshot.thumbnail", ({ stepId }) =>
    local.computerSteps.thumbnail(stepId, signal(15_000)),
  );
  handle("computer.screenshot.view", ({ stepId }) =>
    local.computerSteps.view(stepId, signal(15_000)),
  );
}
