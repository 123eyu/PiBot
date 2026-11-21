import type { WordOperation } from "@pibot/protocol-base/office-ooxml";
import type { OfficePackage } from "../package.ts";
import { comment, footnote } from "./annotations.ts";
import { WordDocument } from "./document.ts";
import { imageWord } from "./image.ts";
import { formatWord, paragraphWord, styleWord } from "./layout.ts";
import { revisions } from "./revisions.ts";
import { headerFooter, sectionWord, toc } from "./section.ts";
import { tableWord } from "./table.ts";
import { bookmark, replaceWordText } from "./text.ts";

export function applyWordOperation(
  pkg: OfficePackage,
  op: WordOperation,
  author: string,
  date: string,
  images: Record<string, Uint8Array>,
) {
  const d = new WordDocument(pkg, author, date, images);
  switch (op.op) {
    case "word_format":
      return formatWord(d, op);
    case "word_paragraph":
      return paragraphWord(d, op);
    case "word_style":
      return styleWord(d, op);
    case "word_section":
      return sectionWord(d, op);
    case "word_header_footer":
      return headerFooter(d, op);
    case "word_toc":
      return toc(d, op);
    case "word_table":
      return tableWord(d, op);
    case "word_image":
      return imageWord(d, op);
    case "word_footnote":
      return footnote(d, op);
    case "word_replace":
      return replaceWordText(d, op.locator, op.oldText, op.newText, op.track);
    case "word_revision":
      return revisions(d, op);
    case "word_comment":
      return comment(d, op);
    case "word_bookmark":
      return bookmark(d, op);
  }
}
