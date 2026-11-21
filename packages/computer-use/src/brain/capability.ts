import type { BrainCapability, ComputerUsePort } from "@pibot/brain/kit";
import type { ComputerContext } from "./context.ts";
import { ComputerGrantService } from "./service/grants/computer-grants.ts";
import { ComputerHandoffService } from "./service/handoff/computer-handoff.ts";
import { registerComputerRpc } from "./service/run/computer-rpc.ts";
import { executeComputer } from "./service/run/computer-run.ts";
import { ComputerSteps } from "./service/steps/computer-steps.ts";
import { registerComputerStepsRpc } from "./service/steps/computer-steps-rpc.ts";
export function computerUseCapability(): BrainCapability {
  return {
    id: "computer-use",
    register(ctx) {
      const runtime = ctx.computer.runtime;
      const local: ComputerContext = {
        ...runtime,
        get computerGrants() {
          return grants;
        },
        get computerSteps() {
          return steps;
        },
        get computerHandoff() {
          return handoff;
        },
      };
      const grants = new ComputerGrantService(local);
      const steps = new ComputerSteps(local);
      const handoff = new ComputerHandoffService(local, ctx.computer.handoffWaitMs);
      local.computerGrants.abortRun = runtime.abortRun;
      local.computerGrants.providerName = runtime.providerName;
      local.computerHandoff.recover();
      const port: ComputerUsePort = {
        grants: {
          authorize: (...args) => grants.authorize(...args),
          release: (id) => grants.release(id),
          drained: (id) => grants.drained(id),
          resolveForYolo: (approval) => grants.resolveForYolo(approval),
          runs: {
            releaseForYolo: () => grants.runs.releaseForYolo(),
            guard: { changed: () => grants.runs.guard.changed() },
          },
          isIdle: () => grants.isIdle(),
          dispose: () => grants.dispose(),
        },
        steps: { record: (...args) => steps.record(...args), dispose: () => steps.dispose() },
        cancel() {
          local.computerHandoff.dispose();
          local.computerGrants.dispose();
        },
        execute: (run, prepared, input, signal) =>
          executeComputer({ ...run, local }, prepared, input, signal),
      };
      ctx.computer.provide(port);
      registerComputerRpc(ctx.rpc.handle, local);
      registerComputerStepsRpc(ctx.rpc.handle, local);
      ctx.sleep.participate({
        idle: () => local.computerGrants.isIdle(),
      });
      return { start: () => local.computerSteps.startSweep() };
    },
  };
}
