import type { Cdp } from "../cdp.ts";
import { clickableNodes } from "./clickable.ts";
import type { Mark } from "./phases.ts";

interface AxValue {
  value?: unknown;
}
interface AxNode {
  nodeId: string;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  properties?: { name: string; value: AxValue }[];
  childIds?: string[];
  backendDOMNodeId?: number;
}

const REF_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "option",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "treeitem",
  "textarea",
  "PopUpButton",
]);
// Text arrives separately through the web_fetch rule; structural wrappers without a name only
// add indentation.
const SKIP_ROLES = new Set([
  "none",
  "generic",
  "presentation",
  "StaticText",
  "InlineTextBox",
  "LineBreak",
  "RootWebArea",
  "WebArea",
  "paragraph",
  "group",
  "LayoutTable",
  "LayoutTableRow",
  "LayoutTableCell",
]);
/** Above this many elements the snapshot text skips Readability (see htmlText). */
const TEXT_READABILITY_ELEMENTS = 5000;
const STATES = ["checked", "selected", "expanded", "disabled", "required", "invalid", "pressed"];

/** Refs stay stable for a node while the document lives; navigation resets them. */
export class RefTable {
  private next = 1;
  private readonly byNode = new Map<number, string>();
  private readonly byRef = new Map<string, number>();
  ref(backendNodeId: number) {
    let ref = this.byNode.get(backendNodeId);
    if (!ref) {
      ref = `e${this.next++}`;
      this.byNode.set(backendNodeId, ref);
      this.byRef.set(ref, backendNodeId);
    }
    return ref;
  }
  node(ref: string) {
    return this.byRef.get(ref);
  }
  get size() {
    return this.byRef.size;
  }
  reset() {
    this.byNode.clear();
    this.byRef.clear();
    this.next = 1;
  }
}

const SECRET_AUTOCOMPLETE = /(password|one-time-code|cc-number|cc-csc|cc-exp)/i;
const TEXT_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);

/**
 * Password, one-time-code and card fields: the accessibility value of such a field may hold what
 * the user typed during takeover, so it never reaches the model.
 */
async function secretFields(cdp: Cdp, nodes: AxNode[]) {
  const all = nodes.filter(
    (node) => TEXT_ROLES.has(String(node.role?.value)) && node.backendDOMNodeId,
  );
  const candidates = all.slice(0, 300);
  // Unclassified fields beyond the inspection budget must not expose their values either.
  const secret = new Set(all.slice(300).map((node) => node.backendDOMNodeId as number));
  await Promise.all(
    candidates.map(async (node) => {
      const backendNodeId = node.backendDOMNodeId as number;
      try {
        const { node: dom } = await cdp.send<{
          node: { localName?: string; attributes?: string[] };
        }>("DOM.describeNode", { backendNodeId });
        const attrs = new Map<string, string>();
        const list = dom.attributes ?? [];
        for (let i = 0; i + 1 < list.length; i += 2)
          attrs.set(String(list[i]).toLowerCase(), String(list[i + 1]));
        if (
          dom.localName === "input" &&
          (attrs.get("type")?.toLowerCase() === "password" ||
            SECRET_AUTOCOMPLETE.test(attrs.get("autocomplete") ?? ""))
        )
          secret.add(backendNodeId);
      } catch {
        // Unknown node kind: fail closed so a value we could not classify is not shown.
        secret.add(backendNodeId);
      }
    }),
  );
  return secret;
}

const quote = (value: unknown, max = 200) =>
  JSON.stringify(
    String(value ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max),
  );

export async function snapshotPage(
  cdp: Cdp,
  refs: RefTable,
  maxChars: number,
  signal?: AbortSignal,
  mark?: Mark,
) {
  signal?.throwIfAborted();
  // The tree, the clickable scan and the page HTML are independent reads of the same
  // document; asked one after another they added up (up to 41 s on a large page in the owner's
  // logs). Refs are still assigned below in a fixed order, so the output is unchanged.
  const [{ nodes }, clickable, html] = await Promise.all([
    cdp.send<{ nodes: AxNode[] }>("Accessibility.getFullAXTree", {}, 15_000),
    clickableNodes(cdp, signal),
    cdp.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
      expression:
        "document.documentElement ? document.documentElement.outerHTML.slice(0, 2000000) : ''",
      returnByValue: true,
    }),
  ]);
  mark?.("read");
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const secret = await secretFields(cdp, nodes);
  mark?.("secret_fields");
  const semantic = new Set(
    nodes
      .filter((node) => REF_ROLES.has(String(node.role?.value)))
      .map((node) => node.backendDOMNodeId),
  );
  const root = nodes[0];
  const lines: string[] = [];
  let size = 0;
  let truncated = false;
  const stack: { id: string; depth: number }[] = root ? [{ id: root.nodeId, depth: 0 }] : [];
  // Iterative pre-order walk: deep pages must not overflow the main-process stack.
  while (stack.length) {
    const { id, depth } = stack.pop() as { id: string; depth: number };
    const node = byId.get(id);
    if (!node) continue;
    const role = String(node.role?.value ?? "");
    const name = node.name?.value;
    const show = !node.ignored && !SKIP_ROLES.has(role) && (name || REF_ROLES.has(role));
    if (show) {
      const parts = [`${"  ".repeat(depth)}- ${role}`];
      if (name) parts.push(quote(name));
      if (REF_ROLES.has(role) && node.backendDOMNodeId)
        parts.push(`[ref=${refs.ref(node.backendDOMNodeId)}]`);
      const props = new Map((node.properties ?? []).map((p) => [p.name, p.value.value]));
      if (props.has("level")) parts.push(`[level=${props.get("level")}]`);
      for (const state of STATES) {
        const value = props.get(state);
        if (value === true || value === "true" || value === "mixed")
          parts.push(value === "mixed" ? `${state}=mixed` : state);
      }
      const value = node.value?.value;
      if (node.backendDOMNodeId && secret.has(node.backendDOMNodeId)) parts.push("secret");
      else if (value !== undefined && value !== "" && role !== "link")
        parts.push(`value=${quote(value)}`);
      const line = parts.join(" ");
      if (size + line.length + 1 > maxChars) {
        truncated = true;
        break;
      }
      lines.push(line);
      size += line.length + 1;
    }
    const children = node.childIds ?? [];
    for (let i = children.length - 1; i >= 0; i--)
      stack.push({ id: children[i] as string, depth: show ? depth + 1 : depth });
  }
  mark?.("tree");
  const { result } = html;
  // Loaded on first snapshot so the owner does not carry linkedom while no Bot browses.
  if (!cdp.htmlText) throw new Error("browser_text_adapter_unavailable");
  const extracted = await cdp.htmlText(typeof result.value === "string" ? result.value : "", {
    maxElements: TEXT_READABILITY_ELEMENTS,
  });
  mark?.("text");
  const body = extracted.text.replace(/\n{3,}/g, "\n\n").trim();
  for (const [node, name] of clickable) {
    if (semantic.has(node) || secret.has(node)) continue;
    const line = `- clickable ${quote(name)} [ref=${refs.ref(node)}]`;
    if (size + line.length + 1 > maxChars) {
      truncated = true;
      break;
    }
    lines.push(line);
    size += line.length + 1;
  }
  const textTruncated = body.length > maxChars;
  signal?.throwIfAborted();
  return {
    tree: lines.join("\n"),
    text: body.slice(0, maxChars) + (textTruncated ? "\n[已截断 / Truncated]" : ""),
    truncated: truncated || textTruncated,
    refs: refs.size,
  };
}
