import { join } from "node:path";
import { sanitizeBrainEnv } from "@pibot/agent/env";
import type { Logger } from "@pibot/observability";
import { utilityProcess } from "electron";

type Options = {
  outputDir: string;
  dataDir: string;
  originalEnv: Readonly<NodeJS.ProcessEnv>;
  logger: Pick<Logger, "info" | "warn">;
  dev: boolean;
  routineTesting?: boolean;
  version?: string;
};

export function forkBrainProcess(options: Options) {
  const env = { ...options.originalEnv };
  sanitizeBrainEnv(env, options.dataDir);
  // A shell's cache location must not pre-enable Node caching outside this data directory.
  for (const key of Object.keys(env))
    if (["PIBOT_TRUSTED_ROUTINE_TEST", "NODE_COMPILE_CACHE"].includes(key.toUpperCase()))
      delete env[key];
  if (
    typeof __PIBOT_DEV_BUILD__ !== "undefined" &&
    __PIBOT_DEV_BUILD__ &&
    options.dev &&
    options.routineTesting
  )
    env.PIBOT_TRUSTED_ROUTINE_TEST = options.dataDir;
  const at = performance.now();
  const child = utilityProcess.fork(join(options.outputDir, "brain.js"), [], {
    env,
    serviceName: "Pi Bot Brain",
    stdio: "ignore",
  });
  child.once("spawn", () =>
    options.logger.info(
      JSON.stringify({
        module: "startup",
        event: "brain_process_spawned",
        forkAtMs: Math.round(at),
        forkToSpawnMs: Math.round(performance.now() - at),
        sinceProcessMs: Math.round(performance.now()),
      }),
    ),
  );
  return { child, at };
}

/** No bootstrap is sent here. The owner must publish the PID before handing over any ports. */
export function prelaunchBrainProcess(options: Options) {
  const forked = forkBrainProcess(options);
  const { child } = forked;
  let owned = true;
  const exited = () => {
    owned = false;
  };
  const terminate = () => {
    try {
      child.kill();
    } catch {
      options.logger.warn("Unbootstrapped brain process stop unavailable");
    }
  };
  const failed = () => {
    options.logger.warn("Unbootstrapped brain process failed");
    terminate();
  };
  child.once("exit", exited);
  child.on("error", failed);
  // Only loads code/cache. The child still waits for the authenticated owner's final
  // bootstrap and transferred ports before creating any database or runtime resources.
  if (options.version) {
    try {
      child.postMessage({ type: "prepare", dataDir: options.dataDir, version: options.version });
    } catch {
      terminate();
      throw new Error("brain_prelaunch_message_unavailable");
    }
  }
  return {
    take() {
      if (!owned) return undefined;
      owned = false;
      child.off("exit", exited);
      child.off("error", failed);
      return forked;
    },
    dispose() {
      if (!owned) return;
      owned = false;
      terminate();
    },
  };
}
