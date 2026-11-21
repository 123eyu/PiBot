import { OfficeError } from "../errors.ts";
import type { Element } from "../ooxml/xml.ts";

const MAX_DEPTH = 32;
const MAX_NODES = 100_000;
const MAX_TEXT_UNITS = 16 * 1024 * 1024;

/** One budget per worker request, including all stories, sheets and slides. */
export class TemplateBudget {
  private parsed = 0;
  private expanded = 0;
  private text = 0;

  depth(value: number) {
    if (value > MAX_DEPTH) throw new OfficeError("office_template_limit");
  }

  parse() {
    if (++this.parsed > MAX_NODES) throw new OfficeError("office_template_limit");
  }

  expand(nodes: number, textUnits = 0) {
    this.expanded += nodes;
    this.text += textUnits;
    if (this.expanded > MAX_NODES || this.text > MAX_TEXT_UNITS)
      throw new OfficeError("office_template_limit");
  }

  // Reserve even for an empty body, since enumerating the input still costs work.
  repeat(count: number, elements: readonly Element[]) {
    if (!count) return;
    this.expand(count);
    for (const element of elements) {
      this.expand(0, (element.end - element.start) * count);
      const stack = [element];
      while (stack.length) {
        const node = stack.pop();
        if (!node) break;
        this.expand(count);
        for (const child of node.children) stack.push(child);
      }
    }
  }
}
