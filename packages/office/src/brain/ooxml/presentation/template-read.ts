import type { PresentationLayouts } from "@pibot/protocol-base/office-content";
import { DOC_REL, OfficePackage } from "../package.ts";
import { attribute, type Element } from "../xml.ts";
import { A, P } from "./parts.ts";
import type { Box } from "./themes.ts";

function children(node: Element, name: string) {
  return node.children.filter((child) => child.uri === P && child.name === name);
}
function first(node: Element, name: string) {
  return children(node, name)[0];
}
export function presentation(pkg: OfficePackage) {
  const part = pkg.mainPart();
  const root = pkg.xml(part).root;
  if (root.uri !== P || root.name !== "presentation") throw new Error("office_unsupported");
  const masterList = first(root, "sldMasterIdLst");
  if (!masterList) throw new Error("office_invalid");
  return { part, root, masterList };
}
export function targets(
  pkg: OfficePackage,
  part: string,
  list: Element,
  node: string,
  kind: string,
) {
  const byId = new Map(pkg.relationships(part).map((rel) => [rel.id, rel]));
  const refs = children(list, node);
  if (
    !refs.length ||
    refs.length > 64 ||
    new Set(refs.map((ref) => attribute(ref, "id", DOC_REL))).size !== refs.length
  )
    throw new Error("office_invalid");
  return refs.map((child) => {
    const id = attribute(child, "id", DOC_REL);
    const rel = id && byId.get(id);
    if (!rel || rel.type !== `${DOC_REL}/${kind}` || !rel.target) throw new Error("office_invalid");
    return rel.target;
  });
}
export function masterLayouts(pkg: OfficePackage, master: string) {
  const root = pkg.xml(master).root;
  const list = first(root, "sldLayoutIdLst");
  if (root.uri !== P || root.name !== "sldMaster" || !list) throw new Error("office_invalid");
  return targets(pkg, master, list, "sldLayoutId", "slideLayout");
}
export function layoutRoot(pkg: OfficePackage, part: string) {
  const root = pkg.xml(part).root;
  if (root.uri !== P || root.name !== "sldLayout") throw new Error("office_invalid");
  return root;
}
function catalogEntry(pkg: OfficePackage, master: string, index: number) {
  return {
    master: index + 1,
    layouts: masterLayouts(pkg, master).map((part, i) => {
      const root = layoutRoot(pkg, part);
      return {
        layout: i + 1,
        name: (
          first(root, "cSld")?.attrs.get("name") ||
          root.attrs.get("matchingName") ||
          ""
        ).slice(0, 120),
        type: (root.attrs.get("type") ?? "cust").slice(0, 32),
        placeholders: placeholders(root, 1, 1)
          .slice(0, 64)
          .map(({ type, index }) => ({ type: type.slice(0, 100), index })),
      };
    }),
  };
}

export async function readPresentationLayouts(bytes: Uint8Array): Promise<PresentationLayouts> {
  const pkg = await OfficePackage.open(bytes);
  const { part, masterList } = presentation(pkg);
  const masters = targets(pkg, part, masterList, "sldMasterId", "slideMaster").slice(0, 8);
  const result: PresentationLayouts = [];
  // Reserve space for the rest of office_inspect's bounded JSON, including the source path.
  let budget = 18 * 1024;
  for (const [index, master] of masters.entries()) {
    const entry = catalogEntry(pkg, master, index);
    const layouts = [];
    for (const item of entry.layouts) {
      const size = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
      if (budget - size < 0) break;
      budget -= size;
      layouts.push(item);
    }
    if (!layouts.length) break;
    result.push({ master: entry.master, layoutCount: entry.layouts.length, layouts });
  }
  return result;
}

export type Placeholder = { type: string; index?: string; box?: Box };
export function placeholders(root: Element, width: number, height: number): Placeholder[] {
  const tree = first(first(root, "cSld") ?? root, "spTree");
  return tree
    ? tree.children.flatMap((shape) => {
        const nv = shape.children.find(
          (node) => node.uri === P && ["nvSpPr", "nvPicPr", "nvGraphicFramePr"].includes(node.name),
        );
        const nvProps = nv && first(nv, "nvPr");
        const ph = nvProps && first(nvProps, "ph");
        const index = ph?.attrs.get("idx");
        if (index !== undefined && (!/^\d{1,10}$/u.test(index) || Number(index) > 4294967295))
          throw new Error("office_unsupported");
        const props = first(shape, "spPr");
        const xfrm = props?.children.find((node) => node.uri === A && node.name === "xfrm");
        const off = xfrm?.children.find((node) => node.uri === A && node.name === "off");
        const ext = xfrm?.children.find((node) => node.uri === A && node.name === "ext");
        const box = {
          x: Number(off?.attrs.get("x")) / width,
          y: Number(off?.attrs.get("y")) / height,
          width: Number(ext?.attrs.get("cx")) / width,
          height: Number(ext?.attrs.get("cy")) / height,
        };
        const valid =
          Object.values(box).every(Number.isFinite) &&
          box.x >= 0 &&
          box.y >= 0 &&
          box.width > 0 &&
          box.height > 0 &&
          box.x + box.width <= 1 &&
          box.y + box.height <= 1;
        return ph
          ? [{ type: ph.attrs.get("type") ?? "obj", index, ...(valid ? { box } : {}) }]
          : [];
      })
    : [];
}
