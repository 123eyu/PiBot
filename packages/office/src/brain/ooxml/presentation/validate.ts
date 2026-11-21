import { hasNamespace } from "../namespaces.ts";
import type { OfficePackage } from "../package.ts";
import { child, children, related, relId, required, type SchemaIssue } from "../schema.ts";
import { elements } from "../xml.ts";
import { pptType, themeType } from "./parts.ts";
import { validateNotes } from "./validate-notes.ts";
import { validateTables } from "./validate-tables.ts";

const layoutTypes = new Set(
  "title tx twoColTx tbl txAndChart chartAndTx dgm chart txAndClipArt clipArtAndTx titleOnly blank txAndObj objAndTx objOnly obj txAndMedia mediaAndTx objOverTx txOverObj txAndTwoObj twoObjAndTx twoObjOverTx fourObj vertTx clipArtAndVertTx vertTitleAndTx vertTitleAndTxOverChart twoObj secHead twoTxTwoObj objTx picTx cust".split(
    " ",
  ),
);
const partKinds: Record<string, string> = {
  sld: "slide",
  sldMaster: "slideMaster",
  sldLayout: "slideLayout",
  notes: "notesSlide",
  notesMaster: "notesMaster",
};
export function validatePresentationPart(
  pkg: OfficePackage,
  part: string,
  type: string | undefined,
  add: SchemaIssue,
) {
  const root = pkg.xml(part).root;
  if (type === pptType("tableStyles")) {
    if (
      !hasNamespace("drawingml", root.uri) ||
      root.name !== "tblStyleLst" ||
      !/^\{[\dA-Fa-f-]{36}\}$/u.test(root.attrs.get("def") ?? "")
    )
      add("invalid_schema", "tableStyles.root-and-default");
  }
  if (type === themeType) {
    if (!hasNamespace("drawingml", root.uri) || root.name !== "theme") {
      add("invalid_schema", "theme.root");
      return;
    }
    required(root, ["themeElements"], add);
    const theme = child(root, "themeElements");
    if (!theme) return;
    required(theme, ["clrScheme", "fontScheme", "fmtScheme"], add);
    const colors = child(theme, "clrScheme"),
      fonts = child(theme, "fontScheme"),
      formats = child(theme, "fmtScheme");
    if (colors)
      required(
        colors,
        [
          "dk1",
          "lt1",
          "dk2",
          "lt2",
          "accent1",
          "accent2",
          "accent3",
          "accent4",
          "accent5",
          "accent6",
          "hlink",
          "folHlink",
        ],
        add,
      );
    if (fonts) {
      required(fonts, ["majorFont", "minorFont"], add);
      for (const font of fonts.children.filter(
        (node) => node.name === "majorFont" || node.name === "minorFont",
      ))
        required(font, ["latin", "ea", "cs"], add);
    }
    if (formats)
      for (const name of ["fillStyleLst", "lnStyleLst", "effectStyleLst", "bgFillStyleLst"]) {
        if ((child(formats, name)?.children.length ?? 0) < 3)
          add("invalid_schema", `theme.style-count:${name}`);
      }
  }
  if (!hasNamespace("pptx", root.uri)) return;
  const kind = partKinds[root.name];
  if (kind && type !== pptType(kind)) add("invalid_content_types");
  validateTables(root, add);
  validateNotes(pkg, part, root, add);
  for (const node of elements(root)) {
    const bounds =
      node.name === "sldId"
        ? [256, 2147483647]
        : ["sldMasterId", "sldLayoutId"].includes(node.name)
          ? [2147483648, 4294967295]
          : undefined;
    if (hasNamespace("pptx", node.uri) && bounds) {
      const id = Number(node.attrs.get("id"));
      if (!Number.isInteger(id) || id < (bounds[0] ?? 0) || id > (bounds[1] ?? 0))
        add("invalid_schema", `presentation.id-range:${node.name}`);
    }
  }
  if (root.name === "presentation") required(root, ["notesSz"], add);
  if (["sld", "sldLayout", "sldMaster", "notes", "notesMaster"].includes(root.name)) {
    required(root, ["cSld"], add);
    const common = child(root, "cSld");
    if (common) required(common, ["spTree"], add);
  }
  if (root.name === "sldLayout") {
    if (root.attrs.has("type") && !layoutTypes.has(root.attrs.get("type") ?? ""))
      add("invalid_schema", "layout.type");
    const master = related(pkg, part, "slideMaster");
    if (master.length !== 1) add("missing_relationship");
    else if (
      master[0]?.target &&
      !related(pkg, master[0].target, "slideLayout").some((rel) => rel.target === part)
    )
      add("missing_relationship");
  }
  if (root.name === "sldMaster") {
    required(root, ["clrMap"], add);
    const list = child(root, "sldLayoutIdLst");
    for (const id of list ? children(list, "sldLayoutId") : []) {
      if (!relId(id) || related(pkg, part, "slideLayout", relId(id)).length !== 1)
        add("missing_relationship");
    }
    if (related(pkg, part, "theme").length !== 1) add("missing_relationship");
  }
  if (root.name === "sld" && related(pkg, part, "slideLayout").length !== 1)
    add("missing_relationship");
}
