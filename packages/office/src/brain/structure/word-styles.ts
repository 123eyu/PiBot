import type { StructureContext } from "./page.ts";
import { byKind, child, nodes, relations, WORD, wordAttr } from "./xml.ts";

export function headingStyles(ctx: StructureContext, main: string) {
  const styles = byKind(relations(ctx.pkg, main), "styles")[0];
  const result = new Map<string, number>();
  if (!styles) return result;
  const xml = ctx.pkg.optional(styles, main);
  if (!xml) return result;
  const definitions = new Map<string, { level?: number; base?: string }>();
  for (const node of nodes(xml.root, "style", WORD)) {
    const id = wordAttr(node, "styleId");
    if (!id) continue;
    const props = child(node, "pPr", WORD);
    const raw = wordAttr(props && child(props, "outlineLvl", WORD), "val");
    const name = wordAttr(child(node, "name", WORD), "val");
    const heading = /^heading\s*([1-9])$/iu.exec(name ?? id)?.[1];
    definitions.set(id, {
      level: raw && /^[0-8]$/u.test(raw) ? Number(raw) + 1 : heading ? Number(heading) : undefined,
      base: wordAttr(child(node, "basedOn", WORD), "val"),
    });
  }
  for (const id of definitions.keys()) {
    const seen = new Set<string>();
    let current: string | undefined = id;
    // A malicious styles part cannot create an unbounded or cyclic ancestry walk.
    while (current && seen.size < 128 && !seen.has(current)) {
      seen.add(current);
      const style = definitions.get(current);
      if (style?.level) {
        result.set(id, style.level);
        break;
      }
      current = style?.base;
    }
  }
  return result;
}
