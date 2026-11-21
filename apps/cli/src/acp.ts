import { Readable, Writable } from "node:stream";
import {
  createAcpAgent,
  createAcpExecutionTarget,
  createAcpFolderStaging,
  createAcpNdJsonStream,
  createAcpRuntime,
} from "@pibot/acp";
import type { AcpOptions } from "./args.ts";
import { dataDirRefusal } from "./data-dir-guard.ts";
import { createHeadless } from "./headless.ts";
import { configureModel, targetBot } from "./run.ts";

/** Explicit stdio ACP entry; stdout is reserved for newline-delimited JSON-RPC frames. */
export async function runAcp(options: AcpOptions): Promise<number> {
  if (!(["darwin", "linux", "win32"] as const).includes(process.platform as never)) {
    process.stderr.write("pibot acp: unsupported_platform\n");
    return 1;
  }
  const refused = await dataDirRefusal(options.dataDir);
  if (refused) {
    process.stderr.write(`pibot acp: ${refused}\n`);
    return 1;
  }
  const picker = createAcpFolderStaging();
  const execution = createAcpExecutionTarget({
    id: `stdio-${process.pid}`,
    platform: process.platform as "darwin" | "linux" | "win32",
    warn: (warning) =>
      process.stderr.write(`${JSON.stringify({ level: "warn", module: "acp", ...warning })}\n`),
  });
  const owner = createHeadless(options.dataDir, {
    pickFolder: picker.host,
    executionTarget: execution.target,
    executionLocation: execution.location,
  });
  let configured: Promise<void> | undefined;
  const ready = (signal: AbortSignal) => {
    configured ??= (async () => {
      await owner.ready;
      if (options.provider) {
        const botId = await targetBot(owner.client, undefined);
        await configureModel(owner.client, botId, options.provider);
      }
    })();
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
      const aborted = () => reject(signal.reason);
      signal.addEventListener("abort", aborted, { once: true });
      void configured
        ?.then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", aborted));
    });
  };
  const runtime = createAcpRuntime({
    rpc: owner.client,
    folders: picker,
    ready,
    timeoutMs: options.timeoutMs,
  });
  const translator = createAcpAgent({
    runtime,
    execution,
    version: "cli",
    runTimeoutMs: options.timeoutMs,
    debug: (event) =>
      process.stderr.write(`${JSON.stringify({ level: "debug", module: "acp", event })}\n`),
  });
  const stream = createAcpNdJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );
  const connection = translator.app.connect(stream);
  let exitCode = 0;
  let closing: Promise<void> | undefined;
  let protocolClosed = false;
  const close = (code: number) => {
    exitCode = Math.max(exitCode, code);
    closing ??= (async () => {
      const failures: unknown[] = [];
      await translator.dispose().catch((error) => failures.push(error));
      // The execution target owns editor terminals. Keep ACP transport alive until brain stop has
      // confirmed terminal kill/release. A failed attempt keeps both identities and the writer
      // claim live, and a later signal may retry while the editor connection is still available.
      try {
        await execution.target.dispose();
      } catch {
        exitCode = 1;
        process.stderr.write("pibot acp: terminal_cleanup_unconfirmed\n");
        return;
      }
      await owner.stop().catch((error) => failures.push(error));
      connection.close();
      protocolClosed = true;
      if (failures.length) {
        exitCode = 1;
        process.stderr.write("pibot acp: cleanup_failed\n");
      }
    })().finally(() => {
      if (!protocolClosed) closing = undefined;
    });
    return closing;
  };
  const interrupt = () => void close(130);
  const terminate = () => void close(143);
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  void owner.ready.catch(() => {
    process.stderr.write("pibot acp: startup_failed\n");
    return close(1);
  });
  process.stderr.write("pibot acp: headless development data only; credentials are unencrypted\n");
  try {
    await connection.closed;
    await close(0);
  } catch {
    process.stderr.write("pibot acp: protocol_error\n");
    await close(1).catch(() => {
      exitCode = 1;
    });
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
  return exitCode;
}
