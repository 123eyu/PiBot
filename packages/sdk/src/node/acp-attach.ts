import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { AcpClientSchema } from "@pibot/protocol/background";
import { connectBackground } from "./background-connection.ts";
import { readAcpFrames, writeAcpFrame } from "./stdio-frames.ts";

export interface AcpAttachOptions {
  dataDir: string;
  version: string;
  platform: NodeJS.Platform;
  input: Readable;
  output: Writable;
  signal?: AbortSignal;
}

export function acpAttachError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "ECONNREFUSED") return "app_not_running";
  if (code === "ELOOP" || code === "EACCES" || code === "EPERM") return "descriptor_insecure";
  const message = error instanceof Error ? error.message : "";
  if (message.includes("version_mismatch")) return "version_mismatch";
  if (["background_descriptor_permissions", "background_endpoint_invalid"].includes(message))
    return "descriptor_insecure";
  if (
    ["app_quit", "acp_busy", "attach_unsupported_platform", "acp_cleanup_unconfirmed"].includes(
      message,
    )
  )
    return message;
  return "protocol_error";
}

function initializeClient(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    !("method" in value) ||
    value.method !== "initialize" ||
    !("params" in value)
  )
    throw new Error("acp_initialize_required");
  const params = value.params;
  if (!params || typeof params !== "object" || Array.isArray(params))
    throw new Error("acp_client_info_required");
  const info = "clientInfo" in params ? params.clientInfo : undefined;
  // ACP currently permits absent/null clientInfo; this label is display data, not identity.
  if (info === undefined || info === null) return { name: "ACP editor", version: "unknown" };
  if (typeof info !== "object" || Array.isArray(info)) throw new Error("acp_client_info_required");
  return AcpClientSchema.parse({
    name: "name" in info ? info.name : undefined,
    version: "version" in info ? info.version : undefined,
  });
}

/** A transport only; owner and utility retain execution and cleanup authority. */
export async function attachAcp(options: AcpAttachOptions): Promise<void> {
  if (options.platform !== "darwin" && options.platform !== "linux")
    throw new Error("attach_unsupported_platform");
  options.signal?.throwIfAborted();
  let lost: () => void = () => {};
  const disconnected = new Promise<void>((resolve) => {
    lost = resolve;
  });
  let peerEnded: () => void = () => {};
  const peerDone = new Promise<void>((resolve) => {
    peerEnded = resolve;
  });
  let failure: Error | undefined;
  let closed = false;
  let cleanupConfirmed = false;
  let remoteEnded = false;
  let outputFailed = false;
  let detaching = false;
  let attached = false;
  const connection = await connectBackground(
    options.dataDir,
    options.version,
    async (frame) => {
      if (frame.kind === "acp") {
        if (outputFailed) return;
        try {
          await writeAcpFrame(options.output, frame.message);
        } catch {
          outputFailed = true;
          failure = new Error("acp_output_failed");
          lost();
        }
      } else if (frame.kind === "acp-error") {
        remoteEnded = true;
        cleanupConfirmed = detaching && frame.code === "app_quit";
        failure = new Error(frame.code);
        peerEnded();
        lost();
      } else throw new Error("acp_unexpected_frame");
    },
    () => {
      closed = true;
      peerEnded();
      failure ??= new Error("app_quit");
      lost();
    },
    options.signal,
    "acp",
  );
  let interrupted: () => void = () => {};
  const interruption = new Promise<void>((resolve) => {
    interrupted = resolve;
  });
  const abort = () => interrupted();
  if (options.signal?.aborted) interrupted();
  options.signal?.addEventListener("abort", abort, { once: true });
  const outputFailure = () => {
    outputFailed = true;
    failure ??= new Error("acp_output_failed");
    lost();
  };
  options.output.on("error", outputFailure);
  options.output.on("close", outputFailure);
  if (options.output.destroyed || options.output.writableEnded) outputFailure();
  const frames = readAcpFrames(options.input);
  let forwarding: Promise<void> | undefined;
  let firstTimer: ReturnType<typeof setTimeout> | undefined;
  const forward = async () => {
    const first = await Promise.race([
      frames.next(),
      disconnected.then(() => undefined),
      interruption.then(() => undefined),
      new Promise<never>((_resolve, reject) => {
        firstTimer = setTimeout(() => reject(new Error("acp_initialize_timeout")), 15_000);
      }),
    ]);
    clearTimeout(firstTimer);
    if (!first || first.done) {
      if (!options.signal?.aborted && failure) throw failure;
      return;
    }
    options.signal?.throwIfAborted();
    const client = initializeClient(first.value);
    attached = true;
    await connection.control({ type: "acp-attach", client }, options.signal);
    await connection.sendAsync({ kind: "acp", message: first.value });
    forwarding = (async () => {
      for await (const message of frames) {
        if (detaching || options.signal?.aborted) return;
        await connection.sendAsync({ kind: "acp", message });
      }
    })();
    await Promise.race([forwarding, disconnected, interruption]);
    if (!options.signal?.aborted && failure) throw failure;
  };
  let resultError: unknown;
  try {
    await forward();
  } catch (error) {
    resultError = failure ?? error;
  } finally {
    clearTimeout(firstTimer);
    options.signal?.removeEventListener("abort", abort);
    detaching = true;
    options.input.destroy();
    await forwarding?.catch(() => {
      /* Destroying stdin ends the pending local read. */
    });
  }
  try {
    if (attached && !closed && !remoteEnded) {
      // Only the owner emits app_quit after its utility drain barrier has completed.
      await connection.sendAsync({
        kind: "control",
        id: randomUUID(),
        control: { type: "acp-detach" },
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          peerDone,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("acp_cleanup_unconfirmed")), 35_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (!cleanupConfirmed) throw new Error("acp_cleanup_unconfirmed");
    }
  } catch (error) {
    resultError = error;
  } finally {
    connection.close();
    options.output.off("error", outputFailure);
    options.output.off("close", outputFailure);
  }
  if (resultError) throw resultError;
}
