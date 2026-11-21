import type { DatabaseSync } from "node:sqlite";
import type { ExecutionTarget } from "@pibot/execution";
import {
  type KernelMethodParams,
  type KernelMethodResults,
  previewKind,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol-base";
import type { RpcRequestContext } from "../../core/business-rpc.ts";
import type { BrainRedactor } from "../../core/privacy.ts";
import { redactValue } from "../../core/privacy.ts";
import type { BrainHost } from "../../index.ts";
import { checkedImage, imageMime } from "./attachment-files.ts";
import { type PreviewSourceDeps, previewSource, previewSourceError } from "./preview-source.ts";

type Handle = <K extends keyof typeof import("@pibot/protocol-base").KernelMethods>(
  method: K,
  action: (
    params: KernelMethodParams[K],
    context: RpcRequestContext,
  ) => Promise<KernelMethodResults[K]>,
) => void;
export function registerPreviewRpc(
  handle: Handle,
  deps: {
    logger: { info(message: string): void };
    db: DatabaseSync;
    dataDir: string;
    host: BrainHost;
    signal: AbortSignal;
    redactor: BrainRedactor;
    target: ExecutionTarget;
    changes: PreviewSourceDeps["changes"];
  },
) {
  const requests = new Map<string, AbortController>();
  const fail = (reason: string): never => {
    throw new RpcError(RpcErrorCodes.invalidParams, reason);
  };
  handle("preview.read", async (input, context) => {
    if (requests.has(input.requestId) || requests.size >= 4) fail("preview_busy");
    const abort = new AbortController();
    requests.set(input.requestId, abort);
    const signal = AbortSignal.any([
      deps.signal,
      context.signal,
      abort.signal,
      AbortSignal.timeout(30_000),
    ]);
    const started = performance.now();
    let kind: string = "unknown",
      sizeBand = "unknown",
      outcome = "ok";
    try {
      const item = await previewSource(deps, input, signal);
      const sourceMs = Math.round(performance.now() - started);
      const detected = previewKind(item.name);
      kind = detected ?? "unknown";
      if (!detected) return fail("preview_unsupported");
      // Made binary reads fail closed without root identities; preview had none, so every
      // preview answered `internal` (outside_workplace).
      const read = await deps.target
        .readBinary({
          cwd: item.root,
          writeRoots: [],
          rootIdentities: [item.rootIdentity],
          path: item.path,
          expectedPath: item.path,
          signal,
        })
        .catch(previewSourceError);
      deps.logger.info(
        JSON.stringify({
          module: "file-preview",
          event: "source_read",
          kind,
          sourceMs,
          readMs: Math.round(performance.now() - started) - sourceMs,
        }),
      );
      sizeBand =
        read.bytes.length < 262144 ? "small" : read.bytes.length < 2097152 ? "medium" : "large";
      if (input.expectedRevision && input.expectedRevision !== read.revision)
        fail("preview_changed");
      const fresh = await previewSource(deps, input, signal);
      if (fresh.path !== item.path || fresh.root !== item.root) fail("preview_changed");
      if (kind === "markdown" || kind === "code" || kind === "svg") {
        if (read.bytes.length > 2_097_152) fail("preview_limit");
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
        } catch {
          return fail("preview_encoding");
        }
        if (kind === "svg") {
          if (/<!DOCTYPE|<!ENTITY/i.test(text)) fail("preview_unsupported");
        } else
          return {
            kind: detected,
            revision: read.revision,
            data: "",
            text: redactValue(text, deps.redactor) as string,
          };
      }
      // Image validation and the RPC response consume the same encoding; avoid encoding large
      // images twice while retaining the byte/magic/dimension checks.
      const data = read.bytes.toString("base64");
      if (kind === "image") checkedImage(data, imageMime(read.bytes));
      return { kind: detected, revision: read.revision, data };
    } catch (error) {
      outcome = signal.aborted
        ? "aborted"
        : error instanceof RpcError && /^preview_[a-z_]+$/.test(error.message)
          ? error.message
          : "preview_failed";
      throw error;
    } finally {
      deps.logger.info(
        JSON.stringify({
          module: "file-preview",
          event: "read",
          kind,
          sizeBand,
          outcome,
          durationMs: Math.round(performance.now() - started),
        }),
      );
      requests.delete(input.requestId);
    }
  });
  handle("preview.cancel", async ({ requestId }) => {
    requests.get(requestId)?.abort();
    return null;
  });
  handle("preview.open", async (input) => {
    const signal = AbortSignal.any([deps.signal, AbortSignal.timeout(30_000)]);
    const item = await previewSource(deps, input, signal);
    if (!deps.host.openPath) throw new RpcError(RpcErrorCodes.unsupported, "preview_unavailable");
    await deps.host.openPath({ path: item.path, allowedRoots: [item.root] }, signal);
    return null;
  });
}
