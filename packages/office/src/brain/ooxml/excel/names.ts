import type { OfficePackage } from "../package.ts";
import { escapeXml } from "../xml.ts";
import { book, reference, sheetPart } from "./model.ts";
import { workbookTables } from "./table-index.ts";
import { bookOrder, children, insert, replace, setChild, ss, unique } from "./xml-edit.ts";

export function definedName(
  pkg: OfficePackage,
  name: string,
  source: { sheet: string; range: string },
) {
  if (
    /^(?:[A-Za-z]{1,3}[1-9][0-9]*|R[0-9]*C[0-9]*|R|C)$/iu.test(name) ||
    name.toLowerCase().startsWith("_xlnm.")
  )
    throw new Error("office_invalid");
  sheetPart(pkg, source.sheet);
  const ref = reference(source),
    b = book(pkg),
    parent = unique(b.xml.root, "definedNames");
  if (tableNames(pkg).has(name.toLowerCase())) throw new Error("office_target_ambiguous");
  const matches = parent
    ? children(parent, "definedName").filter(
        (n) => n.attrs.get("name")?.toLowerCase() === name.toLowerCase(),
      )
    : [];
  if (matches.length > 1 || matches.some((n) => n.attrs.has("localSheetId")))
    throw new Error("office_target_ambiguous");
  const old = matches[0],
    value = ss("definedName", escapeXml(ref), { name }, b.xml.root.uri);
  pkg.replaceXml(
    b.part,
    old
      ? replace(b.xml, old, value)
      : parent
        ? insert(b.xml, parent, value)
        : setChild(b.xml, "definedNames", ss("definedNames", value, {}, b.xml.root.uri), bookOrder),
  );
}

export function tableNames(pkg: OfficePackage) {
  const names = new Set<string>();
  for (const { root } of workbookTables(pkg))
    for (const key of ["name", "displayName"]) {
      const value = root.attrs.get(key);
      if (value) names.add(value.toLowerCase());
    }
  return names;
}
