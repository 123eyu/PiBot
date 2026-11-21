import { parentPort, workerData } from "node:worker_threads";
import {
  OfficeContentSchema,
  OfficeFormatSchema,
  OfficeStructureQuerySchema,
} from "@pibot/protocol-base/office-content";
import { OfficeOperationsSchema, WordReviewKindSchema } from "@pibot/protocol-base/office-ooxml";
import { z } from "zod";
import {
  csvToXlsx,
  docxToMarkdown,
  markdownToDocx,
  markdownToPptx,
  pptxToMarkdown,
  xlsxToCsv,
} from "./codecs/convert.ts";
import { deliveryOffice } from "./codecs/delivery.ts";
import { createOffice, inspectOffice } from "./codecs/index.ts";
import { checkOfficeRender } from "./codecs/render-check.ts";
import { diffOffice, restoreOffice } from "./compare/index.ts";
import { officeErrorCode } from "./errors.ts";
import { extractOfficeText } from "./extract.ts";
import { blocksPublication, editOoxml, validateOoxml } from "./ooxml/index.ts";
import { OfficePackage } from "./ooxml/package.ts";
import { wordReview } from "./ooxml/word/review.ts";
import { inspectStructure } from "./structure/page.ts";
import type { TemplateValue } from "./template/engine.ts";
import { templateFields, templateFill } from "./template/index.ts";

const data = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("word-review"),
    bytes: z.instanceof(Uint8Array),
    kind: WordReviewKindSchema,
    offset: z.number().int().min(0).max(200_000),
    limit: z.number().int().min(1).max(20),
  }),
  z.strictObject({
    action: z.literal("structure"),
    bytes: z.instanceof(Uint8Array),
    format: OfficeFormatSchema,
    query: OfficeStructureQuerySchema.default({}),
  }),
  z.strictObject({
    action: z.literal("delivery"),
    bytes: z.instanceof(Uint8Array),
    format: z.enum(["docx", "xlsx"]),
  }),
  z.strictObject({
    action: z.literal("extract"),
    bytes: z.instanceof(Uint8Array),
    format: OfficeFormatSchema,
  }),
  z.strictObject({
    action: z.literal("inspect"),
    bytes: z.instanceof(Uint8Array),
    format: OfficeFormatSchema,
    includePresentationLayouts: z.boolean().optional(),
  }),
  z.strictObject({
    action: z.literal("render-check"),
    review: z.boolean().optional(),
    bytes: z.instanceof(Uint8Array),
    format: OfficeFormatSchema,
    pages: z.array(z.number().int().min(1).max(10_000)).min(1).max(5),
  }),
  z.strictObject({
    action: z.literal("create"),
    content: OfficeContentSchema,
    acceptValidationErrors: z.boolean(),
    images: z.record(z.string().max(4096), z.instanceof(Uint8Array)).optional(),
    author: z.string().min(1).max(300).default("Pi Bot · Bot"),
  }),
  z.strictObject({
    action: z.literal("validate"),
    bytes: z.instanceof(Uint8Array),
    format: OfficeFormatSchema,
  }),
  z.strictObject({
    action: z.literal("convert"),
    from: z.enum(["docx", "xlsx", "pptx", "markdown", "csv"]),
    to: z.enum(["docx", "xlsx", "pptx", "markdown", "csv"]),
    bytes: z.instanceof(Uint8Array).optional(),
    text: z.string().max(20_000_000).optional(),
    name: z.string().max(200).optional(),
  }),
  z.strictObject({
    action: z.literal("edit"),
    bytes: z.instanceof(Uint8Array),
    format: OfficeFormatSchema,
    operations: OfficeOperationsSchema,
    author: z.string().min(1).max(300).default("Pi Bot · Bot"),
    images: z.record(z.string().max(4096), z.instanceof(Uint8Array)).optional(),
    acceptValidationErrors: z.boolean(),
  }),
  z.strictObject({
    action: z.literal("template"),
    bytes: z.instanceof(Uint8Array),
    format: OfficeFormatSchema,
    mode: z.enum(["fields", "fill"]),
    data: z.unknown().optional(),
    acceptValidationErrors: z.boolean().default(false),
  }),
  z.strictObject({
    action: z.literal("diff"),
    before: z.instanceof(Uint8Array),
    after: z.instanceof(Uint8Array),
    format: OfficeFormatSchema,
  }),
  z.strictObject({
    action: z.literal("restore"),
    before: z.instanceof(Uint8Array),
    after: z.instanceof(Uint8Array),
    format: OfficeFormatSchema,
    item: z.string().min(1).max(120),
  }),
]);
type ConvertInput = Extract<z.infer<typeof data>, { action: "convert" }>;
async function convert(input: ConvertInput) {
  const pairs = new Set([
    "docx:markdown",
    "markdown:docx",
    "xlsx:csv",
    "csv:xlsx",
    "pptx:markdown",
    "markdown:pptx",
  ]);
  if (!pairs.has(`${input.from}:${input.to}`)) throw new Error("office_unsupported");
  if (input.from === "markdown" || input.from === "csv") {
    if (input.text === undefined) throw new Error("office_invalid");
    const content =
      input.from === "markdown"
        ? input.to === "docx"
          ? markdownToDocx(input.text)
          : markdownToPptx(input.text)
        : csvToXlsx(input.name ?? "Sheet1", input.text);
    return { bytes: await createOffice(content, undefined) };
  }
  if (!input.bytes) throw new Error("office_invalid");
  const { content } = await inspectOffice(input.bytes, input.from);
  if (input.to === "markdown")
    return { text: input.from === "docx" ? docxToMarkdown(content) : pptxToMarkdown(content) };
  return { files: xlsxToCsv(content) };
}
async function execute() {
  const input = data.parse(workerData);
  if (input.action === "word-review")
    return {
      wordReview: wordReview(
        await OfficePackage.open(input.bytes),
        input.kind,
        input.offset,
        input.limit,
      ),
    };
  if (input.action === "structure")
    return { structure: await inspectStructure(input.bytes, input.format, input.query) };
  if (input.action === "delivery")
    return { delivery: await deliveryOffice(input.bytes, input.format) };
  if (input.action === "extract")
    return { extracted: extractOfficeText(await inspectOffice(input.bytes, input.format)) };
  if (input.action === "render-check")
    return {
      renderCheck: await checkOfficeRender(input.bytes, input.format, input.pages, input.review),
    };
  if (input.action === "inspect")
    return {
      decoded: await inspectOffice(input.bytes, input.format, input.includePresentationLayouts),
    };
  if (input.action === "validate")
    return { validation: await validateOoxml(input.bytes, input.format) };
  if (input.action === "convert") return { converted: await convert(input) };
  if (input.action === "template") {
    if (input.mode === "fields")
      return { template: await templateFields(input.bytes, input.format) };
    if (input.data === undefined) throw new Error("office_invalid");
    const filled = await templateFill(
      input.bytes,
      input.format,
      input.data as TemplateValue,
      input.acceptValidationErrors,
    );
    return {
      template: filled.scan,
      validation: filled.validation,
      ...("bytes" in filled ? { bytes: filled.bytes } : {}),
    };
  }
  if (input.action === "diff")
    return { diff: await diffOffice(input.before, input.after, input.format) };
  if (input.action === "restore") {
    const restored = await restoreOffice(input.before, input.after, input.format, input.item);
    return restored ? { restored: true, bytes: restored } : { restored: false };
  }
  if (input.action === "edit")
    return editOoxml(
      input.bytes,
      input.format,
      input.operations,
      input.acceptValidationErrors,
      input.author,
      new Date().toISOString(),
      input.images,
    );
  // Only this create operation knows which parts were copied from the template.
  const retainedTemplateParts = new Set<string>();
  const bytes = await createOffice(
    input.content,
    input.images,
    retainedTemplateParts,
    input.author,
  );
  const validation = await validateOoxml(bytes, input.content.kind, retainedTemplateParts);
  return blocksPublication(validation, input.acceptValidationErrors)
    ? { validation }
    : { validation, bytes };
}
void execute().then(
  (result) => parentPort?.postMessage({ ok: true, ...result }),
  (error: unknown) =>
    parentPort?.postMessage({
      ok: false,
      code: officeErrorCode(error instanceof Error ? error.message : undefined),
    }),
);
