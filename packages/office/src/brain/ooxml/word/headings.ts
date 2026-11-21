import { DOC_REL, type OfficePackage, STRICT_REL } from "../package.ts";
import { attribute, type Element, elements } from "../xml.ts";

/** Use the same outline resolution for stable heading locators and Word validation. */
export function headingResolver(pkg: OfficePackage, main: string) {
  const uri = pkg.xml(main).root.uri,
    rels = pkg
      .relationships(main)
      .filter((r) => [`${DOC_REL}/styles`, `${STRICT_REL}/styles`].includes(r.type));
  if (rels.length > 1 || rels.some((r) => !r.target)) throw new Error("office_target_ambiguous");
  const part = rels[0]?.target;
  const styles = part
    ? Array.from(elements(pkg.xml(part).root)).filter((n) => n.uri === uri && n.name === "style")
    : [];
  const attr = (node: Element, name: string) => attribute(node, name, uri);
  const child = (node: Element, name: string) =>
    node.children.find((n) => n.uri === uri && n.name === name);
  const byId = new Map(styles.map((n) => [attr(n, "styleId"), n]));
  const defaults = styles.filter(
    (n) => attr(n, "type") === "paragraph" && ["1", "true"].includes(attr(n, "default") ?? ""),
  );
  const cache = new Map<string, number>();
  const styleLevel = (id: string | undefined): number => {
    if (!id) return 0;
    const saved = cache.get(id);
    if (saved !== undefined) return saved;
    const seen = new Set<string>();
    let current: string | undefined = id,
      result = 0;
    while (current && !seen.has(current) && seen.size < 32) {
      seen.add(current);
      const style = byId.get(current),
        pr = style && child(style, "pPr"),
        outline = pr && child(pr, "outlineLvl"),
        raw = outline && attr(outline, "val");
      if (raw && /^[0-9]$/u.test(raw)) {
        result = raw === "9" ? 0 : Number(raw) + 1;
        break;
      }
      const match = /^Heading([1-9])$/iu.exec(current);
      if (match) {
        result = Number(match[1]);
        break;
      }
      const parent = style && child(style, "basedOn");
      current = parent ? attr(parent, "val") : undefined;
    }
    cache.set(id, result);
    return result;
  };
  return (paragraph: Element) => {
    const pr = child(paragraph, "pPr"),
      outline = pr && child(pr, "outlineLvl"),
      raw = outline && attr(outline, "val");
    if (raw && /^[0-9]$/u.test(raw)) return raw === "9" ? 0 : Number(raw) + 1;
    const style = pr && child(pr, "pStyle");
    return styleLevel(style ? attr(style, "val") : defaults[0] && attr(defaults[0], "styleId"));
  };
}
