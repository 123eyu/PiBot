import { XMLValidator } from "fast-xml-parser";

export interface Element {
  name: string;
  uri: string;
  attrs: ReadonlyMap<string, string>;
  ns: ReadonlyMap<string, string>;
  children: Element[];
  start: number;
  end: number;
  openEnd: number;
  closeStart: number;
  complexText: boolean;
}

const ENTITY = /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: XML 1.0 explicitly allows TAB, LF and CR.
const allowed = /^(?:[\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD]|[\u{10000}-\u{10FFFF}])*$/u;
export function decodeXml(value: string): string {
  if (value.replaceAll(ENTITY, "").includes("&")) throw new Error("office_invalid_xml");
  return value.replaceAll(ENTITY, (_whole, code: string) => {
    if (code === "amp") return "&";
    if (code === "lt") return "<";
    if (code === "gt") return ">";
    if (code === "quot") return '"';
    if (code === "apos") return "'";
    const char = String.fromCodePoint(
      code.startsWith("#x") ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1)),
    );
    if (!allowed.test(char)) throw new Error("office_invalid_xml");
    return char;
  });
}
export function escapeXml(value: string): string {
  if (!allowed.test(value)) throw new Error("office_invalid_xml");
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("\r", "&#13;");
}
export const encoder = new TextEncoder();

function attributes(source: string) {
  const attrs = new Map<string, string>();
  for (const match of source.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) {
    const key = match[1] as string;
    attrs.set(key, decodeXml(match[2] ?? match[3] ?? ""));
  }
  return attrs;
}
export function parsePart(bytes: Uint8Array) {
  if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("office_xml_limit");
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (
    !allowed.test(source) ||
    /<!DOCTYPE|<!ENTITY/iu.test(source) ||
    XMLValidator.validate(source) !== true
  )
    throw new Error("office_invalid_xml");
  const stack: Element[] = [];
  let root: Element | undefined;
  let end = 0;
  let count = 0;
  // Keep source spans; rebuilding a touched XML part can discard extension markup and formatting.
  for (const token of source.matchAll(
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(?:[^<>"']|"[^"]*"|'[^']*')+>/gu,
  )) {
    const text = source.slice(end, token.index);
    if (text.includes("]]>")) throw new Error("office_invalid_xml");
    decodeXml(text);
    const raw = token[0];
    end = token.index + raw.length;
    const parent = stack.at(-1);
    if (raw.startsWith("<!") || raw.startsWith("<?")) {
      if (parent) parent.complexText = true;
      continue;
    }
    if (raw.startsWith("</")) {
      const item = stack.pop();
      if (!item) throw new Error("office_invalid_xml");
      item.closeStart = token.index;
      item.end = end;
      continue;
    }
    if (++count > 200_000 || stack.length >= 128) throw new Error("office_xml_limit");
    const qualified = /^<([^\s/>]+)/u.exec(raw)?.[1];
    if (!qualified) throw new Error("office_invalid_xml");
    const attrs = attributes(raw.slice(1 + qualified.length, raw.endsWith("/>") ? -2 : -1));
    let ns = parent?.ns ?? new Map([["xml", "http://www.w3.org/XML/1998/namespace"]]);
    for (const [key, value] of attrs) {
      if (key === "xmlns" || key.startsWith("xmlns:")) {
        if (ns === parent?.ns) ns = new Map(ns);
        (ns as Map<string, string>).set(key === "xmlns" ? "" : key.slice(6), value);
      }
    }
    const separator = qualified.indexOf(":");
    const prefix = separator === -1 ? "" : qualified.slice(0, separator);
    const uri = ns.get(prefix);
    if (prefix && !uri) throw new Error("office_invalid_xml");
    for (const key of attrs.keys()) {
      const prefix = key.includes(":") ? key.split(":")[0] : undefined;
      if (prefix && prefix !== "xmlns" && !ns.get(prefix)) throw new Error("office_invalid_xml");
    }
    const element: Element = {
      name: qualified.slice(separator + 1),
      uri: uri ?? "",
      attrs,
      ns,
      children: [],
      start: token.index,
      end,
      openEnd: end,
      closeStart: end,
      complexText: false,
    };
    if (parent) parent.children.push(element);
    else if (root) throw new Error("office_invalid_xml");
    else root = element;
    if (!raw.endsWith("/>")) stack.push(element);
  }
  if (!root || stack.length || source.slice(end).trim()) throw new Error("office_invalid_xml");
  return { source, root };
}
export type XmlPart = ReturnType<typeof parsePart>;

export function* elements(node: Element): Generator<Element> {
  yield node;
  for (const child of node.children) yield* elements(child);
}
export function attribute(node: Element, name: string, uri?: string) {
  if (!uri) return node.attrs.get(name);
  for (const [key, value] of node.attrs) {
    const separator = key.indexOf(":");
    if (
      separator !== -1 &&
      key.slice(separator + 1) === name &&
      node.ns.get(key.slice(0, separator)) === uri
    )
      return value;
  }
}
export function leafText(xml: XmlPart, node: Element) {
  if (node.children.length || node.complexText || node.closeStart === node.end) return undefined;
  return decodeXml(xml.source.slice(node.openEnd, node.closeStart));
}
