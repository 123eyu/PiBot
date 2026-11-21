import type { DatabaseSync } from "node:sqlite";
import type {
  BrainHost,
  BrainRedactor,
  PreviewSourceDeps,
  PreviewSourceFile,
  RpcRequestContext,
} from "@pibot/brain/kit";
import { previewSource, previewSourceError, redactValue } from "@pibot/brain/kit";
import type { ExecutionTarget } from "@pibot/execution";
import {
  type MethodParams,
  type MethodResults,
  OfficePreviewSchema,
  RpcError,
  RpcErrorCodes,
} from "@pibot/office-contract/full";
import { officeContentPage } from "./content-page.ts";
import { OfficeError } from "./errors.ts";
import { officeFormat } from "./execute.ts";
import type { OfficeWorkers } from "./worker.ts";

type Handle = <K extends keyof typeof import("@pibot/office-contract/full").Methods>(
  method: K,
  action: (params: MethodParams[K], context: RpcRequestContext) => Promise<MethodResults[K]>,
) => void;
export function registerOfficeRpc(
  handle: Handle,
  deps: {
    db: DatabaseSync;
    dataDir: string;
    host: BrainHost;
    workers: OfficeWorkers;
    signal: AbortSignal;
    redactor: BrainRedactor;
    target: ExecutionTarget;
    /** Files a run changed are resolved by the workspaces capability through the kernel port. */
    changes: PreviewSourceDeps["changes"];
  },
) {
  const requests = new Map<string, AbortController>();
  async function source(
    input: Parameters<typeof previewSource>[1],
    signal: AbortSignal,
  ): Promise<PreviewSourceFile & { format: ReturnType<typeof officeFormat>; signal: AbortSignal }> {
    const item = await previewSource(deps, input, signal);
    if (item.attachmentKind !== undefined && item.attachmentKind !== "file")
      throw new RpcError(RpcErrorCodes.invalidParams, "office_attachment_unavailable");
    return { ...item, format: officeFormat(item.name), signal };
  }

  async function guarded<T>(action: () => Promise<T>) {
    try {
      return await action();
    } catch (error) {
      if (error instanceof OfficeError) throw new RpcError(RpcErrorCodes.invalidParams, error.code);
      throw error;
    }
  }
  handle("office.preview", (input, context) =>
    guarded(async () => {
      if (requests.has(input.requestId) || requests.size >= 8) throw new OfficeError("office_busy");
      const abort = new AbortController();
      requests.set(input.requestId, abort);
      const signal = AbortSignal.any([
        deps.signal,
        context.signal,
        abort.signal,
        AbortSignal.timeout(50_000),
      ]);
      try {
        const item = await source(input, signal);
        // Binary reads fail closed without root identities; preview has no policy boundary.
        const rootIdentities = [item.rootIdentity];
        const read = await deps.target
          .readBinary({
            cwd: item.root,
            writeRoots: [],
            rootIdentities,
            path: item.path,
            expectedPath: item.path,
            signal,
          })
          .catch(previewSourceError);
        if (input.expectedRevision && input.expectedRevision !== read.revision)
          throw new OfficeError("office_changed");
        const { decoded } = await deps.workers.run(
          { action: "inspect", bytes: read.bytes, format: item.format },
          signal,
        );
        if (!decoded) throw new OfficeError("office_invalid");
        const fresh = await source(input, signal);
        if (fresh.path !== item.path || fresh.root !== item.root)
          throw new OfficeError("office_changed");
        const after = await deps.target
          .readBinary({
            cwd: item.root,
            writeRoots: [],
            rootIdentities,
            path: item.path,
            expectedPath: item.path,
            signal,
          })
          .catch(previewSourceError);
        if (after.revision !== read.revision) throw new OfficeError("office_changed");
        return OfficePreviewSchema.parse(
          redactValue(officeContentPage(decoded, read.revision, input), deps.redactor),
        );
      } finally {
        requests.delete(input.requestId);
      }
    }),
  );
  handle("office.cancel", async ({ requestId }) => {
    requests.get(requestId)?.abort();
    return null;
  });
  handle("office.apps", async (input) =>
    deps.host.office
      ? deps.host.office.apps(input, AbortSignal.any([deps.signal, AbortSignal.timeout(20_000)]))
      : { apps: [], defaultAvailable: false },
  );
  handle("office.open", (input) =>
    guarded(async () => {
      const signal = AbortSignal.any([deps.signal, AbortSignal.timeout(30_000)]);
      const item = await source(input, signal);
      if (input.appId) {
        if (!deps.host.office)
          throw new RpcError(RpcErrorCodes.unsupported, "office_host_unavailable");
        await deps.host.office.open(
          {
            botId: item.botId,
            file: item.path,
            allowedRoots: [item.root],
            appId: input.appId,
          },
          signal,
        );
      } else {
        if (!deps.host.openPath)
          throw new RpcError(RpcErrorCodes.unsupported, "office_host_unavailable");
        await deps.host.openPath({ path: item.path, allowedRoots: [item.root] }, signal);
      }
      return null;
    }),
  );
}
