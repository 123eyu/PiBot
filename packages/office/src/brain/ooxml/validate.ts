import type { OfficeFormat, OfficeValidation } from "@pibot/protocol-base";
import { validatePivotPart } from "./excel/validate-pivot.ts";
import { namespaces } from "./namespaces.ts";
import {
  DOC_REL,
  type OfficePackage,
  relationshipSource,
  resolveTarget,
  STRICT_REL,
  TYPES,
  TYPES_NS,
} from "./package.ts";
import { validatePresentationPart } from "./presentation/validate.ts";
import type { SchemaFinding, SchemaIssue } from "./schema.ts";
import { validateWord } from "./word/validate.ts";
import { attribute, type Element, elements } from "./xml.ts";

export { namespaces } from "./namespaces.ts";

const mainTypes = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
};
const rootNames = { docx: "document", xlsx: "workbook", pptx: "presentation" };
const relationshipTypes: Record<string, string> = {
  ...Object.fromEntries(
    ["pivotTable", "pivotCacheDefinition", "pivotCacheRecords"].map((kind) => [
      kind,
      `application/vnd.openxmlformats-officedocument.spreadsheetml.${kind}+xml`,
    ]),
  ),
  ...Object.fromEntries(
    ["slide", "slideLayout", "slideMaster", "notesSlide", "notesMaster"].map((kind) => [
      kind,
      `application/vnd.openxmlformats-officedocument.presentationml.${kind}+xml`,
    ]),
  ),
  theme: "application/vnd.openxmlformats-officedocument.theme+xml",
};
type Code = OfficeValidation["issues"][number]["code"];
export function issueList() {
  const result: OfficeValidation = { serious: 0, notices: 0, issues: [] };
  return {
    result,
    add(code: Code, severity: "serious" | "notice" = "serious") {
      if (severity === "serious") result.serious++;
      else result.notices++;
      if (result.issues.length < 100) result.issues.push({ severity, code });
    },
  };
}

function types(pkg: OfficePackage, add: ReturnType<typeof issueList>["add"]) {
  const defaults = new Map<string, string>(),
    overrides = new Map<string, string>();
  let root: Element;
  try {
    root = pkg.xml(TYPES).root;
  } catch {
    add(pkg.has(TYPES) ? "invalid_xml" : "invalid_content_types");
    return (_part: string): string | undefined => undefined;
  }
  try {
    if (root.name !== "Types" || root.uri !== TYPES_NS) throw new Error("invalid_types");
    for (const node of root.children) {
      const type = node.attrs.get("ContentType");
      if (node.uri !== TYPES_NS || !type || !/^[^\s/]+\/[^\s/]+$/u.test(type))
        throw new Error("invalid_types");
      if (node.name === "Default") {
        const extension = node.attrs.get("Extension")?.toLowerCase();
        if (!extension || !/^[\w-]+$/u.test(extension) || defaults.has(extension))
          throw new Error("invalid_types");
        defaults.set(extension, type);
      } else if (node.name === "Override") {
        const name = node.attrs.get("PartName");
        if (!name?.startsWith("/")) throw new Error("invalid_types");
        const part = resolveTarget("", name);
        if (overrides.has(part)) throw new Error("invalid_types");
        // PowerPoint opens files whose registry lists parts that are gone (DeepSeek's sample
        // deck did), and nothing refers to them, so this is a notice; `write()` drops them.
        if (!pkg.has(part)) add("missing_part", "notice");
        overrides.set(part, type);
      } else throw new Error("invalid_types");
    }
  } catch {
    add("invalid_content_types");
  }
  return (part: string) =>
    overrides.get(part) ?? defaults.get(part.split(".").at(-1)?.toLowerCase() ?? "");
}

function validateIds(
  root: Element,
  rels: Set<string>,
  add: ReturnType<typeof issueList>["add"],
  retainedTemplatePart: boolean,
) {
  const seen = new Set<string>();
  for (const node of elements(root)) {
    for (const [key, value] of node.attrs) {
      const prefix = key.includes(":") ? (key.split(":")[0] as string) : undefined;
      const ns = prefix && node.ns.get(prefix);
      if ((ns === DOC_REL || ns === STRICT_REL) && !rels.has(value)) add("missing_relationship");
    }
    const own = (namespaces.docx as readonly string[]).includes(node.uri)
      ? ["bookmarkStart", "comment", "footnote", "endnote"].includes(node.name)
      : ((namespaces.pptx as readonly string[]).includes(node.uri) &&
          ["cNvPr", "sldId", "sldMasterId", "sldLayoutId"].includes(node.name)) ||
        ((namespaces.xlsx as readonly string[]).includes(node.uri) && node.name === "sheet");
    if (!own || (retainedTemplatePart && node.name === "cNvPr")) continue;
    const id = attribute(
      node,
      node.name === "sheet" ? "sheetId" : "id",
      (namespaces.docx as readonly string[]).includes(node.uri) ? node.uri : undefined,
    );
    if (!id) continue;
    const key = `${node.name}:${id}`;
    if (seen.has(key)) add("duplicate_id");
    seen.add(key);
  }
}

export function validatePackageDetailed(
  pkg: OfficePackage,
  format: OfficeFormat,
  retainedTemplateParts?: ReadonlySet<string>,
) {
  const { result, add } = issueList();
  const schemaFindings = new Map<number, SchemaFinding>();
  const typeOf = types(pkg, add);
  const relationships = new Map<string, Set<string>>();
  for (const part of pkg.names()) {
    if (part === TYPES) continue;
    const type = typeOf(part);
    if (!type) add("missing_content_type");
    if (/vbaProject/i.test(part) || /macroEnabled|vbaProject/i.test(type ?? ""))
      add("macro_present", "notice");
    const source = relationshipSource(part);
    if (source === undefined) continue;
    if (type !== "application/vnd.openxmlformats-package.relationships+xml")
      add("invalid_content_types");
    if (source && !pkg.has(source)) add("missing_part");
    const ids = new Set<string>();
    relationships.set(source, ids);
    try {
      pkg.xml(part);
    } catch {
      add("invalid_xml");
      continue;
    }
    try {
      for (const rel of pkg.relationships(source)) {
        if (ids.has(rel.id)) add("duplicate_id");
        ids.add(rel.id);
        if (rel.external) add("external_relationship", "notice");
        else if (!rel.target || !pkg.has(rel.target)) add("missing_part");
        else {
          const ns = [DOC_REL, STRICT_REL].find((ns) => rel.type.startsWith(`${ns}/`));
          const expected = ns && relationshipTypes[rel.type.slice(ns.length + 1)];
          if (expected && typeOf(rel.target) !== expected) add("invalid_content_types");
        }
      }
    } catch {
      add("invalid_relationship");
    }
  }
  let main: string | undefined;
  try {
    main = pkg.mainPart();
    if (!pkg.has(main)) add("missing_part");
    if (typeOf(main) !== mainTypes[format]) add("invalid_content_types");
  } catch {
    add("missing_part");
  }
  for (const part of pkg.names()) {
    if (part === TYPES || relationshipSource(part) !== undefined) continue;
    const type = typeOf(part);
    if (
      !/\.(?:xml|rels|vml)$/iu.test(part) &&
      !type?.endsWith("+xml") &&
      type !== "application/xml"
    )
      continue;
    try {
      const { root } = pkg.xml(part);
      if (
        part === main &&
        (root.name !== rootNames[format] ||
          !(namespaces[format] as readonly string[]).includes(root.uri))
      )
        add("missing_part");
      if (
        part === main &&
        format === "docx" &&
        !root.children.some((node) => node.uri === root.uri && node.name === "body")
      )
        add("missing_part");
      const schemaIssue: SchemaIssue = (code, rule?, dependencies = []) => {
        // Undisplayed or unidentified findings cannot receive a publication exemption.
        if (code === "invalid_schema" && rule && result.issues.length < 100)
          schemaFindings.set(result.issues.length, { part, rule, dependencies });
        add(code);
      };
      if (format === "pptx") validatePresentationPart(pkg, part, type, schemaIssue);
      if (format === "xlsx") validatePivotPart(pkg, part, type, schemaIssue);
      validateIds(
        root,
        relationships.get(part) ?? new Set(),
        add,
        retainedTemplateParts?.has(part) ?? false,
      );
    } catch {
      add("invalid_xml");
    }
  }
  if (format === "docx" && result.serious === 0) validateWord(pkg, add);
  return { validation: result, schemaFindings };
}

export function validatePackage(
  pkg: OfficePackage,
  format: OfficeFormat,
  retainedTemplateParts?: ReadonlySet<string>,
) {
  return validatePackageDetailed(pkg, format, retainedTemplateParts).validation;
}
