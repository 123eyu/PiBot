import type { OfficeValidation } from "@pibot/protocol-base/office-ooxml";
import type { OfficePackage } from "../package.ts";
import { WordDocument } from "./document.ts";
import { headingResolver } from "./headings.ts";

export function validateWord(
  pkg: OfficePackage,
  add: (code: OfficeValidation["issues"][number]["code"], severity: "notice") => void,
) {
  const d = new WordDocument(pkg, "Pi Bot", ""),
    xml = pkg.xml(d.main),
    resolveLevel = headingResolver(pkg, d.main);
  let previous = 0;
  for (const p of d.all(xml, "p")) {
    const n = resolveLevel(p);
    if (!n) continue;
    if (n > previous + 1) add("word_heading_jump", "notice");
    if (!d.plain(xml, p).trim()) add("word_empty_heading", "notice");
    previous = n;
  }
  for (const table of d.all(xml, "tbl")) {
    const first = table.children.find((n) => n.uri === d.uri && n.name === "tr"),
      pr = first && d.child(first, "trPr"),
      header = pr && d.child(pr, "tblHeader");
    if (!header || ["0", "false", "off"].includes(d.attr(header, "val") ?? ""))
      add("word_table_missing_header", "notice");
  }
}
