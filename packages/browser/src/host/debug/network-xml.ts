/** Conservative XML subset. Attributes, entities, DTD, CDATA and mixed content require a
 * full XML parser; omit those bodies instead of guessing which bytes are credentials. */
export function maskXml(
  input: string,
  sensitive: (name: string) => boolean,
  hide: (value: string, name: string) => string,
): string | undefined {
  const source = input.replace(/^\s*<\?xml\s+version=["']1\.0["']\s*\?>/, "").trim();
  if (/[&!?]/.test(source)) return undefined;
  let cursor = 0;
  const parse = (
    depth: number,
    sensitiveParent = false,
  ): { raw: string; safe: string } | undefined => {
    if (depth > 20) return undefined;
    const open = /^<([A-Za-z_][\w.:-]*)(\s*\/?)>/.exec(source.slice(cursor));
    if (!open) return undefined;
    const name = open[1] ?? "";
    cursor += open[0].length;
    if (open[2]?.includes("/")) return { raw: "", safe: open[0] };
    const start = cursor;
    const children: string[] = [];
    while (!source.startsWith(`</${name}>`, cursor)) {
      if (cursor >= source.length) return undefined;
      if (source[cursor] === "<") {
        const child = parse(
          depth + 1,
          sensitiveParent || sensitive(name.split(":").at(-1) ?? name),
        );
        if (!child) return undefined;
        children.push(child.safe);
      } else {
        const end = source.indexOf("<", cursor);
        if (end < 0) return undefined;
        const text = source.slice(cursor, end);
        if (children.length && text.trim()) return undefined;
        if (sensitiveParent && text) hide(text, name);
        children.push(text);
        cursor = end;
      }
    }
    const raw = source.slice(start, cursor);
    if (raw.includes("<") && children.some((child) => child.trim() && !child.startsWith("<")))
      return undefined;
    cursor += name.length + 3;
    return {
      raw,
      safe: `${open[0]}${sensitive(name.split(":").at(-1) ?? name) ? hide(raw, name) : children.join("")}</${name}>`,
    };
  };
  const result = parse(0);
  return cursor === source.length ? result?.safe : undefined;
}
