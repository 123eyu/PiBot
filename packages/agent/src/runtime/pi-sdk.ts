import { Worker } from "node:worker_threads";

/**
 * pi-coding-agent is the single largest module graph on the brain's startup path
 * (≈1 s idle, 3–5 s under load), yet nothing before the first model operation needs it. It is
 * loaded on first use, or by the background preload after the brain reports ready. The patched
 * `./sdk` entry skips the interactive modes but core still imports some theme/TUI dependencies.
 *
 * Callers must sanitize the process environment first (`sanitizeBrainEnv`): the SDK captures
 * auxiliary directories and ambient provider keys at import time.
 */
export function loadPiSdk() {
  // ESM owns module caching; no mutable cache is shared between runtime instances here.
  return import("@earendil-works/pi-coding-agent/sdk");
}

let compileCacheWarmup: Promise<void> | undefined;

/**
 * Warm Node's on-disk module compile cache away from the brain event loop before the first SDK
 * operation. The worker never receives credentials, paths, prompts, or runtime state.
 */
export function warmPiSdkCompileCache(): Promise<void> {
  compileCacheWarmup ??= new Promise<void>((resolve, reject) => {
    const worker = new Worker(
      'import { parentPort } from "node:worker_threads"; import("@earendil-works/pi-coding-agent/sdk").then(() => parentPort?.postMessage("ready"), () => parentPort?.postMessage("failed"));',
      { eval: true, type: "module" },
    );
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(new Error("pi_sdk_compile_cache_timeout"));
    }, 30_000);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      worker.removeAllListeners();
      void worker.terminate();
      if (error) reject(error);
      else resolve();
    };
    worker.once("message", (message: unknown) => {
      finish(message === "ready" ? undefined : new Error("pi_sdk_compile_cache_failed"));
    });
    worker.once("error", (error) => finish(error));
    worker.once("exit", (code) => {
      if (code !== 0) finish(new Error("pi_sdk_compile_cache_worker_exit"));
    });
  }).catch((error) => {
    compileCacheWarmup = undefined;
    throw error;
  });
  return compileCacheWarmup;
}
