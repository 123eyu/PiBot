import { one } from "../locate.ts";
import { attribute, encoder, escapeXml } from "../xml.ts";
import { W14, W15, type WordDocument } from "./document.ts";
export function paragraphId(d: WordDocument) {
  const used = new Set<string>();
  for (const part of d.pkg.names())
    if (part.endsWith(".xml"))
      for (const p of d.all(d.pkg.xml(part), "p")) {
        const id = attribute(p, "paraId", W14);
        if (id) used.add(id);
      }
  let id = 1;
  while (used.has(id.toString(16).padStart(8, "0").toUpperCase())) id++;
  return id.toString(16).padStart(8, "0").toUpperCase();
}
export function extended(d: WordDocument) {
  const type = "http://schemas.microsoft.com/office/2011/relationships/commentsExtended";
  const found = d.pkg.relationships(d.main).filter((r) => r.type === type);
  if (found.length)
    return (
      one(found).target ??
      (() => {
        throw new Error("office_invalid");
      })()
    );
  let n = 0,
    part: string;
  do {
    part = d.main.replace(/[^/]+$/u, `commentsExtended${n++ || ""}.xml`);
  } while (d.pkg.has(part));
  d.pkg.addPart(
    part,
    encoder.encode(`<w15:commentsEx xmlns:w15="${W15}"/>`),
    "application/vnd.ms-word.commentsExtended+xml",
  );
  d.relationship(part, "commentsExtended", false, type);
  return part;
}
export function commentEx(
  d: WordDocument,
  part: string,
  paraId: string,
  parent?: string,
  done = false,
) {
  const xml = d.pkg.xml(part);
  const matches = xml.root.children.filter(
    (n) => n.uri === W15 && attribute(n, "paraId", W15) === paraId,
  );
  const value = `<w15:commentEx xmlns:w15="${W15}" w15:paraId="${escapeXml(paraId)}"${parent ? ` w15:paraIdParent="${escapeXml(parent)}"` : ""} w15:done="${done ? 1 : 0}"/>`;
  if (matches.length) d.replace(part, xml, one(matches), value);
  else d.insert(part, xml, xml.root, value);
}
