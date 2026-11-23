// The desktop composition owns import registration, guarded source selection, and shutdown.
import type { BrainCapability } from "@pibot/brain/kit";
import type { ImportParams } from "@pibot/import-contract/full";
import { RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import { ImportStore } from "../store/index.ts";
import { ImportJobs } from "./jobs.ts";

export function importCapability(): BrainCapability {
  return {
    id: "import",
    register(ctx) {
      const jobs = new ImportJobs(ctx, new ImportStore(ctx.db, ctx.redactor));
      if (!ctx.host.pickFile) return { start: () => jobs.recover() };
      ctx.sleep.participate({ idle: () => jobs.idle() });
      const handle = ctx.rpc.handle;
      const desktop = (source?: "acp") => {
        if (source === "acp") throw new RpcError(RpcErrorCodes.unsupported, "import_desktop_only");
      };
      handle("import.detect", ({ source }: ImportParams<"import.detect">, request) => {
        desktop(request.source);
        return jobs.detect(source, request.signal);
      });
      handle("import.preview", ({ source }: ImportParams<"import.preview">, request) => {
        desktop(request.source);
        return jobs.preview(source, request.signal);
      });
      handle("import.start", ({ importId, botId }: ImportParams<"import.start">, request) => {
        desktop(request.source);
        return jobs.start(importId, botId);
      });
      handle("import.status", ({ importId }: ImportParams<"import.status">, request) => {
        desktop(request.source);
        return jobs.status(importId);
      });
      handle("import.cancel", ({ importId }: ImportParams<"import.cancel">, request) => {
        desktop(request.source);
        return jobs.cancel(importId);
      });
      handle("import.undo", ({ importId }: ImportParams<"import.undo">, request) => {
        desktop(request.source);
        return jobs.undo(importId);
      });
      return { start: () => jobs.recover(), stop: () => jobs.stop() };
    },
  };
}
