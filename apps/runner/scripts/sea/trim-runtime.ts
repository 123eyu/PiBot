import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { packageCommand } from "./command.ts";
import type { Target } from "./types.ts";

/** Official Darwin Node contains hundreds of thousands of local symbols; keep exported addon ABI. */
export async function trimRuntime(binary: string, target: Target) {
  const before = (await stat(binary)).size;
  if (target.platform === "darwin") {
    if (process.platform !== "darwin") throw new Error("runner_macos_strip_requires_macos");
    await packageCommand("/usr/bin/strip", ["-x", binary]);
  } else if (target.platform === "linux") {
    const tool =
      process.env.PIBOT_RUNNER_STRIP ??
      (process.platform === "linux" ? "/usr/bin/strip" : undefined);
    if (tool) {
      if (!isAbsolute(tool)) throw new Error("runner_strip_configuration");
      // GNU/LLVM strip retain the dynamic symbols needed by N-API; never strip exported ABI.
      await packageCommand(tool, ["--strip-unneeded", binary]);
    } else {
      process.stdout.write(
        "runner runtime: Linux cross-strip unavailable; use a Linux host or PIBOT_RUNNER_STRIP if the size budget fails\n",
      );
    }
  }
  process.stdout.write(`runner runtime bytes: ${before} -> ${(await stat(binary)).size}\n`);
}
