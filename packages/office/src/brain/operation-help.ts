import { OfficeContentSchema, type OfficeFormat } from "@pibot/protocol-base/office-content";
import {
  ExcelOperationSchema,
  OfficeTextOperationsSchema,
  PptOperationSchema,
} from "@pibot/protocol-base/office-ooxml";
import { z } from "zod";

/** Full argument shapes stay out of the permanent tool list and are returned on request. */
export function officeOperationHelp(format?: OfficeFormat) {
  if (!format)
    return {
      operationHelp:
        "Call office_capabilities with format=docx/xlsx/pptx for operation parameters and limits.",
    };
  const replace = OfficeTextOperationsSchema.element.options[1];
  const schema =
    format === "docx"
      ? OfficeTextOperationsSchema.element
      : format === "xlsx"
        ? z.union([replace, ExcelOperationSchema])
        : z.union([replace, PptOperationSchema]);
  const parameters = z.toJSONSchema(schema, { io: "input" });
  delete parameters.$schema;
  return {
    operationParameters: parameters,
    ...(format === "pptx"
      ? {
          createContentParameters: z.toJSONSchema(OfficeContentSchema.options[2], { io: "input" }),
          createLimits:
            "PPT objects/themes/layouts are office_create content fields, not ppt_* edit operations. Up to 200 slides, 20 objects per slide, 240 total objects and 20 charts. theme and template are mutually exclusive. templateLayout is one-based from inspect presentationLayouts. Object box coordinates are normalized; secondaryText is only for two-column. SmartArt is built from native grouped shapes (kind flow/cycle/hierarchy/list/matrix/timeline, 2–8 items) and reads back its node text and links. PNG/JPEG and permitted template paths require separate read authorization; templates with complex/active/external resources are refused. Native charts contain editable embedded workbooks; no scripts/macros execute.",
        }
      : {}),
    operationLimits:
      format === "xlsx"
        ? "1–100 atomic operations. A1 ranges and sheet names refer only to this workbook. Format/table <=10000 cells; row heights <=10000 rows. Charts: <=32 series, each range one-dimensional <=10000 cells, total categories/X+Y <=20000 points; sheet/range references use current cached values, errors/missing values are gaps, no recalculation. Chart name adds or updates one unique chart. Tables, worksheet filters and merged cells must not overlap; remove filters/merges first. Table headers must match existing text cells. Validation ranges cannot overlap; dates use Excel serials, errorTitle<=32/error<=225. Global defined names refer to ranges; complex formulas, secondary axes and generic rule deletion are unsupported. Pivot tables take a header range or table: at most one row field and one column field, up to 16 value fields (sum/count/average), optional filters whose values preserve string/number/null types; grand totals and the pivot cache are written, results are also stored as cell values, and multi-level fields are unsupported."
        : format === "docx"
          ? "1–100 atomic operations; paragraph numbers are one-based and later operations see earlier edits. Sizes/margins/widths use twips, run sizes half-points, images pixels; every local image needs authorized read. word_replace can span adjacent plain runs and track with the actual Bot author. Review IDs come from office_read.wordReview. Fields, nested/moved/row/paragraph-mark revisions and cross-paragraph bookmark replacements are refused. TOC/PAGE fields update after opening."
          : "replace_text matches one textual run inside the located shape; slide numbers are one-based. powerpoint_placeholder type accepts the type office_read reports, where title and ctrTitle are interchangeable and body covers a placeholder without a type; a shape the slide only inherits from its layout has no text of its own to replace. 1–100 atomic operations; each is applied in order. ppt_transform/ppt_delete/ppt_duplicate/ppt_snap address one shape id from inspect; align/size need 2+ ids and distribute 3+ ids on one slide and use the union of their frames. ppt_group merges top-level shapes, ppt_ungroup restores children and refuses rotated or flipped groups. ppt_z_order moves within the shape tree and keeps extLst last. ppt_slide_add inserts after a one-based index (default: append) using the create content model, refuses image objects, takes the layout of a neighbouring slide and copies charts. ppt_slide_duplicate copies the page with notes and charts; ppt_slide_delete removes the page reference but not shared layout/theme parts, and the last page stays. Other slides' parts keep their bytes.",
  };
}
