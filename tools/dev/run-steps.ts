import { spawn } from "node:child_process";

/** One command of a check pipeline; `label` prefixes its output when steps run side by side. */
export interface Step {
  label: string;
  command: string;
  args: string[];
}

/**
 * Runs one step. Output is passed through as is when the step runs alone, or line-prefixed when
 * it shares the terminal with others, so interleaved logs stay readable.
 */
function runStep(step: Step, prefixed: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(step.command, step.args, {
      stdio: prefixed ? ["ignore", "pipe", "pipe"] : "inherit",
      // pnpm resolves to a .cmd shim on Windows; a shell finds it without us building paths.
      shell: process.platform === "win32",
    });
    if (prefixed)
      for (const stream of [child.stdout, child.stderr]) {
        let rest = "";
        stream?.setEncoding("utf8");
        stream?.on("data", (chunk: string) => {
          const lines = (rest + chunk).split("\n");
          rest = lines.pop() ?? "";
          for (const line of lines) process.stdout.write(`[${step.label}] ${line}\n`);
        });
        stream?.on("end", () => {
          if (rest) process.stdout.write(`[${step.label}] ${rest}\n`);
        });
      }
    child.on("error", reject);
    child.on("exit", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${step.label} failed (${signal ?? code})`)),
    );
  });
}

/** Steps of one stage run side by side; the next stage starts only when all of them passed. */
export async function runStages(stages: Step[][]): Promise<void> {
  for (const stage of stages) {
    const started = Date.now();
    const results = await Promise.allSettled(stage.map((step) => runStep(step, stage.length > 1)));
    const failed = results.flatMap((r) => (r.status === "rejected" ? [String(r.reason)] : []));
    const labels = stage.map((step) => step.label).join(" + ");
    console.log(
      `── ${labels}: ${failed.length ? "FAILED" : "ok"} in ${Math.round((Date.now() - started) / 1000)}s`,
    );
    if (failed.length) throw new Error(failed.join("; "));
  }
}

export const pnpm = (label: string, ...args: string[]): Step => ({ label, command: "pnpm", args });
