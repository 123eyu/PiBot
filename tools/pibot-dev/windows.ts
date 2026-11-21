import { pnpmEnv, store } from "./context.ts";
import type { TaskRecord } from "./state.ts";
import { createWindowsTester } from "./windows/orchestrate.ts";
import type { WindowsTestOptions } from "./windows/types.ts";

export type {
  WindowsCheck,
  WindowsStageReceipt,
  WindowsTestOptions,
  WindowsTestResult,
} from "./windows/types.ts";

/** Fixed, isolated Windows checks; no installer, owner restart or model-generated commands. */
export async function testWin(task: TaskRecord, options: WindowsTestOptions = {}) {
  return createWindowsTester({ dir: store.dir, env: pnpmEnv, host: process.platform })(
    task,
    options,
  );
}
