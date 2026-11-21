import { hasNamespace } from "../namespaces.ts";
import { type OfficePackage, relationshipPart } from "../package.ts";
import { child, children, related, relId, required, type SchemaIssue } from "../schema.ts";
import { type Element, elements } from "../xml.ts";

export function validateNotes(pkg: OfficePackage, part: string, root: Element, add: SchemaIssue) {
  if (root.name === "presentation") {
    const list = child(root, "notesMasterIdLst");
    const ids = list ? children(list, "notesMasterId") : [];
    if (ids.length > 1) add("invalid_schema", "notes.master-count");
    for (const id of ids)
      if (!relId(id) || related(pkg, part, "notesMaster", relId(id)).length !== 1)
        add("missing_relationship");
    for (const rel of related(pkg, part, "notesMaster"))
      if (!ids.some((id) => relId(id) === rel.id)) add("missing_relationship");
  }
  if (root.name === "sld") {
    const notes = related(pkg, part, "notesSlide");
    if (notes.length > 1) add("invalid_schema", "notes.slide-count", [relationshipPart(part)]);
    for (const rel of notes)
      if (!rel.target || !related(pkg, rel.target, "slide").some((r) => r.target === part))
        add("missing_relationship");
  }
  if (root.name === "notesMaster") {
    required(root, ["clrMap"], add);
    if (related(pkg, part, "theme").length !== 1) add("missing_relationship");
    if (!related(pkg, pkg.mainPart(), "notesMaster").some((rel) => rel.target === part))
      add("missing_relationship");
  }
  if (root.name !== "notes") return;
  const slides = related(pkg, part, "slide"),
    masters = related(pkg, part, "notesMaster");
  if (slides.length !== 1 || masters.length !== 1) add("missing_relationship");
  if (
    slides[0]?.target &&
    !related(pkg, slides[0].target, "notesSlide").some((r) => r.target === part)
  )
    add("missing_relationship");
  // Notes inherit by placeholder type; their idx values can differ from the master's.
  for (const node of elements(root))
    if (
      hasNamespace("pptx", node.uri) &&
      node.name === "ph" &&
      !["hdr", "dt", "sldImg", "body", "ftr", "sldNum"].includes(node.attrs.get("type") ?? "obj")
    )
      add("invalid_schema", "notes.placeholder-type");
}
