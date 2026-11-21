import type { ComputerElement } from "@pibot/protocol-base";
import type { RawElement, Rect } from "../core/types.ts";
import { TEXT_ROLE } from "./secure-input.ts";

export interface ElementFacts {
  secure: boolean;
  enabled?: boolean;
  frame?: Rect;
  /** The label as read; kept so a token from an older snapshot can be re-identified. */
  label?: string;
  role: string;
  /** What the driver says the element supports (macOS: AX action names such as AXPress). */
  actions: string[];
  /** The parent's token, when it has one (select on a cell selects its row). */
  parent?: string;
  /**
   * The ancestors as role+label pairs, from the parent up. Undefined when a parent token is
   * missing from that read (a truncated tree): an unprovable chain is not an identity. Stored on
   * the facts so a token issued to the model keeps its identity after the read is gone.
   */
  chain?: string[];
  /** Position among siblings with the same role and label, and how many of them there were. */
  ordinal?: number;
  siblings?: number;
  /**
   * A text element this read could not certify as "not a password field": input into it needs an
   * OS focus confirmation. Only set on text elements.
   */
  secureUnverified?: boolean;
}

// macOS AXSecureTextField (role or subrole) and AT-SPI "password text" surface with one of
// these words in the role Cua reports. Cua on Windows reports password edits as plain Edit,
// so Windows relies on the OS focus check instead (drivers/win-secure-focus.ts).
const SECURE_ROLE = /secure|password/i;
const SECURE_HINT = /^(secure|password|密码)/i;

export function isSecureElement(
  e: Pick<RawElement, "role" | "valueDescription" | "secure">,
): boolean {
  return (
    e.secure === true || SECURE_ROLE.test(e.role) || SECURE_HINT.test(e.valueDescription ?? "")
  );
}

const clip = (text: string | undefined, max: number) =>
  text === undefined || text === ""
    ? undefined
    : text.length > max
      ? `${text.slice(0, max - 1)}…`
      : text;

/**
 * The label that names an element, never the text it holds. Cua on macOS fills `label` with the
 * element's own content when it has no title or description (TextEdit's document area, an
 * Electron input without aria-label), so a text element whose label equals its value is labelled
 * by what it contains. Keeping that as a label made every token issued before a
 * write stale, and — once values are hidden — leaked the content as the element's name.
 */
export function ownLabel(e: Pick<RawElement, "role" | "label" | "value">): string | undefined {
  if (e.label === undefined) return undefined;
  if (!TEXT_ROLE.test(e.role) || e.value === undefined) return e.label;
  const label = e.label.trim();
  return label !== "" && label === e.value.trim() ? undefined : e.label;
}

/**
 * Role+label of every ancestor, nearest first. Computed from the read rather than from the token
 * facts of the parents: a container may be untokened (shown for context only) and a filter may
 * drop it, but the element's place in the tree is still what tells it apart. `undefined` when the
 * parent links do not close, since a chain that does not end at the root proves nothing.
 */
function ancestors(e: RawElement, byIndex: Map<number, RawElement>): string[] | undefined {
  const out: string[] = [];
  const seen = new Set<number>([e.index]);
  for (let at = e.parentIndex === undefined ? undefined : byIndex.get(e.parentIndex); at; ) {
    if (seen.has(at.index) || out.length >= 64) return undefined;
    seen.add(at.index);
    out.push(`${at.role}\u0000${ownLabel(at) ?? ""}`);
    at = at.parentIndex === undefined ? undefined : byIndex.get(at.parentIndex);
  }
  return out;
}

/** What tells an element from its lookalikes: role, label, ancestors and its place among them. */
export interface ElementIdentity {
  role: string;
  label?: string;
  chain?: string[];
  ordinal: number;
  siblings: number;
}

/**
 * Identity of every element of one read, by raw index. Computed in one pass over the whole read so
 * the numbers are stable whether or not the caller later filters: a filter must not renumber the
 * tree, or an identical sibling would change places behind the model's back.
 */
export function identitiesOf(raw: RawElement[]): Map<number, ElementIdentity> {
  const byIndex = new Map<number, RawElement>();
  for (const e of raw) byIndex.set(e.index, e);
  const groupOf = (e: RawElement) =>
    `${e.parentIndex ?? "root"}\u0000${e.role}\u0000${ownLabel(e) ?? ""}`;
  const totals = new Map<string, number>();
  for (const e of raw) totals.set(groupOf(e), (totals.get(groupOf(e)) ?? 0) + 1);
  const seen = new Map<string, number>();
  const out = new Map<number, ElementIdentity>();
  for (const e of raw) {
    const group = groupOf(e);
    const ordinal = seen.get(group) ?? 0;
    seen.set(group, ordinal + 1);
    const chain = ancestors(e, byIndex);
    const label = ownLabel(e);
    out.set(e.index, {
      role: e.role,
      ...(label !== undefined ? { label } : {}),
      ...(chain ? { chain } : {}),
      ordinal,
      siblings: totals.get(group) ?? 1,
    });
  }
  return out;
}

const KEY_SEP = "\u001f";

/**
 * One string for that identity, so two reads (or a read and a remembered scan) can compare them
 * without repeating five field comparisons. Undefined when the ancestors are unknown: a chain that
 * does not end at the root cannot tell this field apart from another window's field on top of it.
 */
export function identityKey(
  id:
    | (Pick<ElementIdentity, "role" | "label" | "chain"> & {
        ordinal?: number;
        siblings?: number;
      })
    | undefined,
): string | undefined {
  // The facts kept for a token carry the place only when the read counted it; without it this is
  // not an identity either, so both sides of a comparison have to come from a counted read.
  if (!id?.chain || id.ordinal === undefined || id.siblings === undefined) return undefined;
  return [
    id.role,
    id.label ?? "",
    String(id.ordinal),
    String(id.siblings),
    id.chain.join(KEY_SEP),
  ].join(`${KEY_SEP}${KEY_SEP}`);
}

/**
 * Driver elements → protocol elements. Secure fields keep their type and lose their value;
 * a filter keeps matching elements plus their ancestors so the hierarchy still reads.
 * Elements without a token are shown (context) but cannot be acted on.
 */
export function toElements(
  raw: RawElement[],
  options: {
    filter?: string;
    maxNodes: number;
    maxDepth: number;
    /** The read's identities when the caller already computed them; otherwise computed here. */
    identities?: Map<number, ElementIdentity>;
  },
): {
  elements: ComputerElement[];
  facts: Map<string, ElementFacts>;
  truncated: boolean;
  omitted: number;
} {
  const byIndex = new Map<number, RawElement>();
  for (const e of raw) byIndex.set(e.index, e);
  const idOf = (e: RawElement) => e.token ?? `#${e.index}`;
  const identities = options.identities ?? identitiesOf(raw);
  let keep: Set<number> | undefined;
  if (options.filter) {
    const needle = options.filter.toLowerCase();
    keep = new Set();
    for (const e of raw) {
      const secure = isSecureElement(e);
      // Match on the label the element is *shown* with: a filter must not hit on content Cua
      // copied into the label, or a hidden value would still be guessable by search.
      const text = [e.role, identities.get(e.index)?.label, secure ? undefined : e.value]
        .join(" ")
        .toLowerCase();
      if (!text.includes(needle)) continue;
      for (let at: RawElement | undefined = e; at && !keep.has(at.index); ) {
        keep.add(at.index);
        at = at.parentIndex === undefined ? undefined : byIndex.get(at.parentIndex);
      }
    }
  }
  const elements: ComputerElement[] = [];
  const facts = new Map<string, ElementFacts>();
  let truncated = false;
  let omitted = 0;
  for (const e of raw) {
    if (keep && !keep.has(e.index)) continue;
    if (e.depth > options.maxDepth || elements.length >= options.maxNodes) {
      truncated = true;
      omitted++;
      continue;
    }
    const secure = isSecureElement(e);
    const parent = e.parentIndex === undefined ? undefined : byIndex.get(e.parentIndex);
    const identity = identities.get(e.index);
    const element: ComputerElement = {
      id: idOf(e),
      role: e.role.slice(0, 100),
      actions: e.actions.slice(0, 30).map((a) => a.slice(0, 100)),
      depth: e.depth,
    };
    // Read through the identity, not off the element: values are cleared after the identity pass
    // for a reused or partial scan, and a label that was the value must disappear with it.
    // `identities` always covers every element of this read.
    const name = clip(identity?.label, 500);
    if (name) element.name = name;
    if (secure) element.secure = true;
    else {
      const value = clip(e.value ?? e.valueDescription, 500);
      if (value) element.value = value;
    }
    if (e.enabled === false) element.enabled = false;
    if (e.selected) element.selected = true;
    if (e.frame) element.bounds = e.frame;
    if (parent) element.parent = idOf(parent);
    elements.push(element);
    if (e.token)
      facts.set(e.token, {
        secure,
        ...(e.enabled === false ? { enabled: false } : {}),
        frame: e.frame,
        // Bounded (up to 200 elements per window are kept); 4096 characters still tells labels apart.
        ...(identity?.label ? { label: identity.label.slice(0, 4096) } : {}),
        role: e.role,
        actions: e.actions,
        ...(parent?.token ? { parent: parent.token } : {}),
        ...(identity?.chain ? { chain: identity.chain } : {}),
        ...(identity ? { ordinal: identity.ordinal, siblings: identity.siblings } : {}),
      });
  }
  return { elements, facts, truncated, omitted };
}
