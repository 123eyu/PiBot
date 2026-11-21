import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import type { ExtractedOffice } from "@pibot/brain/kit";
import {
  OfficeChangeItemSchema,
  OfficeRenderCheckSchema,
  OfficeStructurePageSchema,
  type OfficeStructureQuery,
} from "@pibot/protocol-base";
import {
  type OfficeContent,
  OfficeContentSchema,
  type OfficeDecoded,
  type OfficeFormat,
  OfficePresentationLayoutsSchema,
} from "@pibot/protocol-base/office-content";
import {
  type OfficeOperation,
  type OfficeValidation,
  OfficeValidationSchema,
  type WordReviewPage,
  WordReviewPageSchema,
} from "@pibot/protocol-base/office-ooxml";
import { z } from "zod";
import { OfficeError, officeErrorCode } from "./errors.ts";

const renderCheck = z.strictObject({
  check: OfficeRenderCheckSchema,
  scan: z
    .string()
    .max(2 * 1024 * 1024)
    .nullable(),
});
export type OfficeWork =
  | {
      action: "word-review";
      bytes: Uint8Array;
      kind: WordReviewPage["kind"];
      offset: number;
      limit: number;
    }
  | { action: "structure"; bytes: Uint8Array; format: OfficeFormat; query: OfficeStructureQuery }
  | {
      action: "render-check";
      bytes: Uint8Array;
      format: OfficeFormat;
      pages: number[];
      review?: boolean;
    }
  | { action: "delivery"; bytes: Uint8Array; format: "docx" | "xlsx" }
  | { action: "extract"; bytes: Uint8Array; format: OfficeFormat }
  | {
      action: "inspect";
      bytes: Uint8Array;
      format: OfficeFormat;
      includePresentationLayouts?: boolean;
    }
  | {
      action: "create";
      content: OfficeContent;
      author?: string;
      acceptValidationErrors: boolean;
      images?: Record<string, Uint8Array>;
    }
  | { action: "validate"; bytes: Uint8Array; format: OfficeFormat }
  | {
      action: "convert";
      from: "docx" | "xlsx" | "pptx" | "markdown" | "csv";
      to: "docx" | "xlsx" | "pptx" | "markdown" | "csv";
      bytes?: Uint8Array;
      text?: string;
      name?: string;
    }
  | {
      action: "edit";
      bytes: Uint8Array;
      format: OfficeFormat;
      operations: OfficeOperation[];
      author?: string;
      images?: Record<string, Uint8Array>;
      acceptValidationErrors: boolean;
    }
  | {
      action: "diff";
      before: Uint8Array;
      after: Uint8Array;
      format: OfficeFormat;
    }
  | {
      action: "template";
      bytes: Uint8Array;
      format: OfficeFormat;
      mode: "fields" | "fill";
      data?: unknown;
      acceptValidationErrors?: boolean;
    }
  | {
      action: "restore";
      before: Uint8Array;
      after: Uint8Array;
      format: OfficeFormat;
      item: string;
    };
/** Fields returned to the caller; filling also reports where placeholders were found. */
type TemplateSummary = {
  format: "docx" | "xlsx" | "pptx";
  fields: {
    path: string;
    kinds: ("value" | "condition" | "list")[];
    count: number;
    scopes: string[];
  }[];
  warnings: string[];
};
const decoded = z.strictObject({
  format: z.enum(["docx", "xlsx", "pptx"]),
  content: OfficeContentSchema,
  presentationLayouts: OfficePresentationLayoutsSchema.optional(),
  warnings: z.array(z.string().max(500)).max(30),
  features: z.strictObject({
    macros: z.boolean(),
    externalLinks: z.boolean(),
    encrypted: z.boolean(),
    unsupported: z.boolean(),
  }),
});
const response = z.union([
  z.strictObject({ ok: z.literal(true), wordReview: WordReviewPageSchema }),
  z.strictObject({ ok: z.literal(true), structure: OfficeStructurePageSchema }),
  z.strictObject({
    ok: z.literal(true),
    converted: z.strictObject({
      text: z.string().max(20_000_000).optional(),
      bytes: z
        .instanceof(Uint8Array)
        .refine((value) => value.byteLength <= 20 * 1024 * 1024)
        .optional(),
      files: z
        .array(z.strictObject({ name: z.string().max(120), text: z.string().max(20_000_000) }))
        .max(50)
        .optional(),
    }),
  }),
  z.strictObject({ ok: z.literal(true), renderCheck }),
  z.strictObject({
    ok: z.literal(true),
    delivery: z.strictObject({
      text: z.string().max(2_000_000),
      columns: z.array(z.string().max(10_000)).max(100),
      hasChart: z.boolean(),
    }),
  }),
  z.strictObject({
    ok: z.literal(true),
    extracted: z.strictObject({
      text: z.string().max(1_000_000),
      totalChars: z.number().int().nonnegative(),
      scanned: z.boolean(),
      pages: z.number().int().nonnegative(),
    }),
  }),
  z.strictObject({
    ok: z.literal(true),
    diff: z.strictObject({
      items: z.array(OfficeChangeItemSchema).max(200),
      omitted: z.number().int().nonnegative(),
    }),
  }),
  z.strictObject({
    ok: z.literal(true),
    restored: z.boolean(),
    bytes: z
      .instanceof(Uint8Array)
      .refine((value) => value.byteLength <= 100 * 1024 * 1024)
      .optional(),
  }),
  z.strictObject({ ok: z.literal(false), code: z.string().max(100) }),
  z.strictObject({ ok: z.literal(true), decoded }),
  z.strictObject({
    ok: z.literal(true),
    template: z.strictObject({
      format: z.enum(["docx", "xlsx", "pptx"]),
      fields: z.array(
        z.strictObject({
          path: z.string().max(200),
          kinds: z.array(z.enum(["value", "condition", "list"])).max(3),
          count: z.number().int().positive(),
          scopes: z.array(z.string().max(200)).max(200),
        }),
      ),
      warnings: z.array(z.string().max(100)).max(50),
    }),
    validation: OfficeValidationSchema.optional(),
    bytes: z
      .instanceof(Uint8Array)
      .refine((value) => value.byteLength <= 100 * 1024 * 1024)
      .optional(),
  }),
  z.strictObject({
    ok: z.literal(true),
    validation: OfficeValidationSchema,
    bytes: z
      .instanceof(Uint8Array)
      .refine((value) => value.byteLength <= 100 * 1024 * 1024)
      .optional(),
  }),
]);

/** A service-owned worker set is bounded; cancelling waits for real worker termination. */
export class OfficeWorkers {
  private active = 0;
  private readonly shutdown = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private drainFailed = false;
  run(input: OfficeWork, parent: AbortSignal) {
    if (this.drainFailed) throw new OfficeError("office_cancelled");
    this.shutdown.signal.throwIfAborted();
    const operation = this.perform(input, AbortSignal.any([parent, this.shutdown.signal]));
    this.pending.add(operation);
    void operation
      .finally(() => this.pending.delete(operation))
      .catch(() => {
        // The caller observes the failure; this observer only tracks the real worker lifetime.
      });
    return operation;
  }
  async stop() {
    this.shutdown.abort();
    await Promise.allSettled([...this.pending]);
    if (this.drainFailed) throw new OfficeError("office_cancelled");
  }
  private async terminate(worker: Worker | undefined, counted: boolean) {
    try {
      await worker?.terminate();
    } catch {
      // A failed termination cannot certify idle or permit the owner to release resources.
      this.drainFailed = true;
      throw new OfficeError("office_cancelled");
    } finally {
      if (counted) this.active--;
    }
  }
  private async perform(
    input: OfficeWork,
    parent: AbortSignal,
  ): Promise<{
    wordReview?: z.infer<typeof WordReviewPageSchema>;
    structure?: z.infer<typeof OfficeStructurePageSchema>;
    decoded?: OfficeDecoded;
    validation?: OfficeValidation;
    renderCheck?: z.infer<typeof renderCheck>;
    bytes?: Uint8Array;
    extracted?: ExtractedOffice;
    delivery?: { text: string; columns: string[]; hasChart: boolean };
    converted?: {
      text?: string;
      bytes?: Uint8Array;
      files?: { name: string; text: string }[];
    };
    diff?: { items: import("@pibot/protocol-base").OfficeChangeItem[]; omitted: number };
    restored?: boolean;
    template?: TemplateSummary;
  }> {
    parent.throwIfAborted();
    // Attachment admission remains with its caller, as before the codec moved packages.
    const counted = input.action !== "extract";
    if (counted && this.active >= 4) throw new OfficeError("office_busy");
    if (
      Buffer.byteLength(
        JSON.stringify(
          input.action === "create"
            ? input.content
            : input.action === "edit"
              ? input.operations
              : {},
        ),
        "utf8",
      ) > 2_000_000
    )
      throw new OfficeError("office_invalid");
    if (counted) this.active++;
    let worker: Worker | undefined;
    const signal = AbortSignal.any([parent, AbortSignal.timeout(45_000)]);
    let stop: (() => void) | undefined;
    try {
      const bundle = new URL("./office-worker.js", import.meta.url);
      const source = new URL("./worker-entry.ts", import.meta.url);
      worker = new Worker(existsSync(bundle) ? bundle : source, {
        workerData: input,
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
        stdout: true,
        stderr: true,
      });
      worker.stdout?.resume();
      worker.stderr?.resume();
      return await new Promise((resolve, reject) => {
        stop = () => reject(new OfficeError("office_cancelled"));
        signal.addEventListener("abort", stop, { once: true });
        worker?.once("message", (value: unknown) => {
          const checked = response.safeParse(value);
          if (!checked.success) return reject(new OfficeError("office_invalid"));
          if (!checked.data.ok) return reject(new OfficeError(officeErrorCode(checked.data.code)));
          if ("wordReview" in checked.data) resolve({ wordReview: checked.data.wordReview });
          else if ("delivery" in checked.data) resolve({ delivery: checked.data.delivery });
          else if ("diff" in checked.data) resolve({ diff: checked.data.diff });
          else if ("restored" in checked.data)
            resolve({ restored: checked.data.restored, bytes: checked.data.bytes });
          else if ("structure" in checked.data) resolve({ structure: checked.data.structure });
          else if ("converted" in checked.data) resolve({ converted: checked.data.converted });
          else if ("renderCheck" in checked.data)
            resolve({ renderCheck: checked.data.renderCheck });
          else if ("decoded" in checked.data) resolve({ decoded: checked.data.decoded });
          else if ("template" in checked.data)
            resolve({
              template: checked.data.template,
              validation: checked.data.validation,
              bytes: checked.data.bytes,
            });
          else if ("validation" in checked.data)
            resolve({ validation: checked.data.validation, bytes: checked.data.bytes });
          else resolve({ extracted: checked.data.extracted });
        });
        worker?.once("error", () => reject(new OfficeError("office_invalid")));
        worker?.once("exit", () => reject(new OfficeError("office_invalid")));
        if (signal.aborted) stop();
      });
    } finally {
      if (stop) signal.removeEventListener("abort", stop);
      await this.terminate(worker, counted);
    }
  }
}
