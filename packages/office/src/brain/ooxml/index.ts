import type {
  ExcelOperation,
  OfficeFormat,
  OfficeOperation,
  OfficeTextOperation,
  PptOperation,
} from "@pibot/protocol-base";
import { applyExcel } from "./excel/index.ts";
import { locate, one } from "./locate.ts";
import { OfficePackage } from "./package.ts";
import { applyPptOperation } from "./presentation/edit.ts";
import { withoutPreexistingSchemaIssues } from "./schema-baseline.ts";
import { issueList, validatePackage, validatePackageDetailed } from "./validate.ts";
import { applyWordOperation } from "./word/index.ts";
import { escapeXml, leafText } from "./xml.ts";

export { locate } from "./locate.ts";
export { OfficePackage } from "./package.ts";
export { validatePackage } from "./validate.ts";

export async function validateOoxml(
  bytes: Uint8Array,
  format: OfficeFormat,
  retainedTemplateParts?: ReadonlySet<string>,
) {
  let pkg: OfficePackage;
  try {
    pkg = await OfficePackage.open(bytes);
  } catch {
    const issues = issueList();
    issues.add("invalid_archive");
    return issues.result;
  }
  return validatePackage(pkg, format, retainedTemplateParts);
}

function applyText(
  pkg: OfficePackage,
  format: OfficeFormat,
  operation: Extract<OfficeTextOperation, { op: "replace_text" }>,
) {
  const { part, xml, nodes, shared } = locate(pkg, format, operation.locator);
  if (operation.locator.kind === "excel_defined_name" || operation.locator.kind === "excel_table")
    throw new Error("office_unsupported");
  const { node, text } = one(
    nodes.flatMap((node) => {
      const text = leafText(xml, node);
      if (text === undefined) return [];
      const index = text.indexOf(operation.oldText);
      if (index < 0) return [];
      if (text.indexOf(operation.oldText, index + 1) >= 0)
        throw new Error("office_target_ambiguous");
      return [
        {
          node,
          text:
            text.slice(0, index) + operation.newText + text.slice(index + operation.oldText.length),
        },
      ];
    }),
  );
  let open = xml.source.slice(node.start, node.openEnd);
  // Leading/trailing spaces are meaningful in Office text; retain the existing element and run.
  if (/^\s|\s$/u.test(text)) {
    if (node.attrs.has("xml:space"))
      open = open.replace(/\s+xml:space\s*=\s*(?:"[^"]*"|'[^']*')/u, ' xml:space="preserve"');
    else open = `${open.slice(0, -1)} xml:space="preserve">`;
  }
  const replacement = open + escapeXml(text);
  if (!shared) {
    pkg.replaceXml(
      part,
      xml.source.slice(0, node.start) + replacement + xml.source.slice(node.closeStart),
    );
    return;
  }
  const item =
    xml.source.slice(shared.item.start, node.start) +
    replacement +
    xml.source.slice(node.closeStart, shared.item.end);
  const index = xml.root.children.filter(
    (child) => child.uri === xml.root.uri && child.name === "si",
  ).length;
  const before = xml.source.slice(0, xml.root.start);
  const rootOpen = xml.source
    .slice(xml.root.start, xml.root.openEnd)
    .replace(/\s+uniqueCount\s*=\s*(?:"[^"]*"|'[^']*')/u, "");
  // Leave other cells' shared-string indices unchanged; extLst, when present, stays last.
  const insert =
    xml.root.children.find((child) => child.uri === xml.root.uri && child.name === "extLst")
      ?.start ?? xml.root.closeStart;
  pkg.replaceXml(
    part,
    before +
      rootOpen +
      xml.source.slice(xml.root.openEnd, insert) +
      item +
      xml.source.slice(insert),
  );
  pkg.replaceXml(
    shared.part,
    shared.xml.source.slice(0, shared.node.openEnd) +
      index +
      shared.xml.source.slice(shared.node.closeStart),
  );
}

export function blocksPublication(
  validation: Awaited<ReturnType<typeof validateOoxml>>,
  acceptValidationErrors: boolean,
) {
  // The accept flag does not waive archive/XML safety, including issues after the display cap.
  const unsafe = validation.issues.some(
    ({ code }) => code === "invalid_archive" || code === "invalid_xml",
  );
  return (
    validation.serious > 0 &&
    (!acceptValidationErrors ||
      unsafe ||
      validation.serious + validation.notices > validation.issues.length)
  );
}

function isExcelOperation(operation: OfficeOperation): operation is ExcelOperation {
  return operation.op.startsWith("excel_");
}

function isPptOperation(operation: OfficeOperation): operation is PptOperation {
  return operation.op.startsWith("ppt_");
}

export async function editOoxml(
  bytes: Uint8Array,
  format: OfficeFormat,
  operations: OfficeOperation[],
  acceptValidationErrors: boolean,
  author = "Pi Bot",
  date = new Date().toISOString(),
  images: Record<string, Uint8Array> = {},
) {
  const pkg = await OfficePackage.open(bytes);
  // Only precisely identified findings in untouched parts can survive an edit as notices.
  const baselinePackage = await OfficePackage.open(bytes);
  const baseline = validatePackageDetailed(baselinePackage, format);
  for (const operation of operations) {
    if (operation.op === "replace_text") applyText(pkg, format, operation);
    else if (isExcelOperation(operation)) {
      if (format !== "xlsx") throw new Error("office_unsupported");
      applyExcel(pkg, operation);
    } else if (isPptOperation(operation)) {
      if (format !== "pptx") throw new Error("office_unsupported");
      await applyPptOperation(pkg, operation);
    } else {
      if (format !== "docx") throw new Error("office_unsupported");
      applyWordOperation(pkg, operation, author, date, images);
    }
  }
  const validation = withoutPreexistingSchemaIssues(
    validatePackageDetailed(pkg, format),
    baseline,
    pkg,
    baselinePackage,
  );
  if (blocksPublication(validation, acceptValidationErrors)) return { validation };
  const candidate = pkg.write();
  // Output compression is also untrusted with respect to the archive limits.
  await OfficePackage.open(candidate);
  return { validation, bytes: candidate };
}
