import type { ComputerUsePort } from "./port.ts";

const unavailable = {
  allow: false,
  reason: "Operating the computer is unavailable / 无法操作电脑",
};
/** Missing capabilities never authorize a tool or manufacture a recorded step. */
export const unavailableComputer: Pick<ComputerUsePort, "grants" | "steps"> = {
  grants: {
    authorize: async () => unavailable,
    release: async () => {},
    drained: () => {},
    resolveForYolo: async () => {
      throw new Error("computer_unavailable");
    },
    runs: { releaseForYolo: async () => {}, guard: { changed() {} } },
    isIdle: () => true,
    dispose() {},
  },
  steps: { record: async () => undefined, dispose: async () => {} },
};
