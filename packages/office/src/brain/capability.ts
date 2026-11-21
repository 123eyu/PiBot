import type { BrainCapability } from "@pibot/brain/kit";
import {
  OFFICE_COMPARE_PORT,
  type OfficeComparePort,
  type OfficeMethodParams,
} from "@pibot/office-contract";
import { BotsRepo } from "@pibot/storage";
import { diffOffice, restoreOffice } from "./compare/index.ts";
import { OfficeError } from "./errors.ts";
import { executeOffice } from "./execute.ts";
import { RenderReports } from "./render-reports.ts";
import { registerOfficeRpc } from "./rpc.ts";
import { OfficeWorkers } from "./worker.ts";
export function officeCapability(): BrainCapability {
  return {
    id: "office",
    register(ctx) {
      const workers = new OfficeWorkers();
      const reports = new RenderReports(ctx.db);
      ctx.rpc.handle("office.renderStep", async (input: OfficeMethodParams["office.renderStep"]) =>
        reports.step(input),
      );
      ctx.rpc.handle(
        "office.renderSnapshot",
        async (input: OfficeMethodParams["office.renderSnapshot"]) => reports.snapshot(input),
      );
      ctx.office.provide({
        delivery: async (bytes, format, signal) => {
          const result = await workers.run({ action: "delivery", bytes, format }, signal);
          if (!result.delivery) throw new OfficeError("office_invalid");
          return result.delivery;
        },
        execute: (run, prepared, input, signal) =>
          executeOffice(
            run,
            prepared,
            input,
            signal,
            workers,
            reports,
            new BotsRepo(ctx.db).get(run.context.botId)?.name ?? "Bot",
          ),
        extract: async (bytes, format, signal) => {
          const result = await workers.run({ action: "extract", bytes, format }, signal);
          if (!result.extracted) throw new OfficeError("office_invalid");
          return result.extracted;
        },
      });
      // The changes panel compares by document structure through this port; it never
      // links the office implementation, only its contract.
      const compare: OfficeComparePort = {
        diff: async ({ format, before, after, signal }) => {
          const result = await workers.run({ action: "diff", before, after, format }, signal);
          if (!result.diff) throw new OfficeError("office_invalid");
          return result.diff;
        },
        restore: async ({ format, before, after, item, signal }) => {
          const result = await workers.run(
            { action: "restore", before, after, format, item },
            signal,
          );
          return result.restored && result.bytes ? result.bytes : null;
        },
      };
      ctx.ports.provide(OFFICE_COMPARE_PORT, compare);
      registerOfficeRpc(ctx.rpc.handle, {
        db: ctx.db,
        dataDir: ctx.dataDir,
        host: ctx.host,
        workers,
        signal: ctx.local.shutdown.signal,
        redactor: ctx.redactor,
        target: ctx.local.target,
        changes: () => ctx.local.changes,
      });
      return {
        stop: async () => {
          reports.stop();
          await workers.stop();
        },
      };
    },
  };
}
