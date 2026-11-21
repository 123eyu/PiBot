import { DOC_REL, type OfficePackage } from "../package.ts";
import { attribute, elements } from "../xml.ts";
import { A, type PresentationParts } from "./parts.ts";
export function addPackageMetadata(parts: PresentationParts, presentation: string) {
  const root = parts.root;
  const presProps = `${root}/presProps.xml`;
  const viewProps = `${root}/viewProps.xml`;
  const tableStyles = `${root}/tableStyles.xml`;
  const core = parts.isStandard ? "docProps/core.xml" : `${root}/core.xml`;
  const app = parts.isStandard ? "docProps/app.xml" : `${root}/app.xml`;
  parts.part(
    presProps,
    "application/vnd.openxmlformats-officedocument.presentationml.presProps+xml",
    `<p:presentationPr xmlns:p="${"http://schemas.openxmlformats.org/presentationml/2006/main"}"/>`,
  );
  parts.part(
    viewProps,
    "application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml",
    `<p:viewPr xmlns:p="${"http://schemas.openxmlformats.org/presentationml/2006/main"}"/>`,
  );
  parts.part(
    tableStyles,
    "application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml",
    `<a:tblStyleLst xmlns:a="${A}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`,
  );
  parts.part(
    core,
    "application/vnd.openxmlformats-package.core-properties+xml",
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>PiBot</dc:creator></cp:coreProperties>`,
  );
  parts.part(
    app,
    "application/vnd.openxmlformats-officedocument.extended-properties+xml",
    `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>PiBot</Application><PresentationFormat>On-screen Show (16:9)</PresentationFormat></Properties>`,
  );
  parts.relate(presentation, "presProps", presProps);
  parts.relate(presentation, "viewProps", viewProps);
  parts.relate(presentation, "tableStyles", tableStyles);
  parts.relate("", "core-properties", core, {
    namespace: "http://schemas.openxmlformats.org/package/2006/relationships/metadata",
  });
  parts.relate("", "extended-properties", app, {
    namespace: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  });
}

export function assertUniquePresentationIds(pkg: OfficePackage, generatedRoot?: string) {
  const presentation = pkg.mainPart();
  const root = pkg.xml(presentation).root;
  const seen = new Set<string>();
  for (const list of root.children.filter(
    (node) => node.name === "sldMasterIdLst" || node.name === "sldIdLst",
  )) {
    for (const item of list.children) {
      const id = item.attrs.get("id");
      if (id && seen.has(id)) throw new Error("office_invalid");
      if (id) seen.add(id);
    }
  }
  const refs = root.children.find((node) => node.name === "sldMasterIdLst")?.children ?? [];
  for (const ref of refs) {
    const relId = attribute(ref, "id", DOC_REL);
    const master = relId && pkg.relationships(presentation).find((rel) => rel.id === relId)?.target;
    if (!master) continue;
    const list = pkg.xml(master).root.children.find((node) => node.name === "sldLayoutIdLst");
    for (const item of list?.children ?? []) {
      const id = item.attrs.get("id");
      if (id && seen.has(id)) throw new Error("office_invalid");
      if (id) seen.add(id);
    }
  }
  // Source template shapes keep their original IDs; check only newly generated shapes.
  if (!generatedRoot) return;
  for (const name of pkg.names()) {
    if (!name.startsWith(`${generatedRoot}/`) || !name.endsWith(".xml")) continue;
    const shapeIds = new Set<string>();
    for (const node of elements(pkg.xml(name).root)) {
      if (node.name !== "cNvPr") continue;
      const id = node.attrs.get("id");
      if (id && shapeIds.has(id)) throw new Error("office_invalid");
      if (id) shapeIds.add(id);
    }
  }
}
