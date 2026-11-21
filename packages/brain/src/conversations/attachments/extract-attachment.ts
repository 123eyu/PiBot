import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import { z } from "zod";

const resultSchema = z.strictObject({
  ok: z.literal(true),
  text: z.string().max(1_000_000),
  totalChars: z.number().int().nonnegative(),
  scanned: z.boolean(),
  pages: z.number().int().nonnegative(),
});
export async function extractAttachment(
  data: Buffer,
  pdf: boolean,
  signal: AbortSignal,
  options: { maxPages?: number } = {},
) {
  signal.throwIfAborted();
  const bundled = new URL("./attachment-worker.js", import.meta.url);
  const source = new URL("./attachment-worker.ts", import.meta.url);
  const worker = new Worker(existsSync(bundled) ? bundled : source, {
    workerData: { data: new Uint8Array(data), pdf, maxPages: options.maxPages },
    resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
    // PDF.js diagnostics may contain document data; do not forward library stdout/stderr.
    stdout: true,
    stderr: true,
  });
  worker.stdout?.resume();
  worker.stderr?.resume();
  let abort: (() => void) | undefined;
  try {
    return await new Promise<z.infer<typeof resultSchema>>((resolve, reject) => {
      abort = () =>
        reject(new RpcError(RpcErrorCodes.attachmentConversion, "attachment_conversion"));
      signal.addEventListener("abort", abort, { once: true });
      worker.once("message", (value: unknown) => {
        const result = resultSchema.safeParse(value);
        if (result.success) resolve(result.data);
        else abort?.();
      });
      worker.once("error", abort);
      worker.once("exit", abort);
      if (signal.aborted) abort();
    });
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
    await worker.terminate();
  }
}
