/*
 * Some agents write a model's variants into its value: Cursor lists `composer-2.5` and
 * `composer-2.5[fast=true]` under the same name. The values stay opaque (the agent refuses a
 * rewritten one), so the picker only groups the advertised ids into one entry per model and offers
 * the variant switches between ids that exist; whatever is chosen is sent exactly as listed.
 */
export type ModelOption = { id: string; name: string };
type Params = Record<string, string>;
export type Variant = ModelOption & { params: Params };
export type ModelFamily = { base: string; name: string; variants: Variant[] };
/** A switch between variants: `fast` on/off, or a key with several values. */
export type VariantControl =
  | { key: string; kind: "toggle"; on: boolean }
  | { key: string; kind: "choice"; value: string; values: string[] };

const VARIANT = /^(.+?)\[([^\]]*)\]$/u;

export function parseVariant(id: string): { base: string; params: Params } {
  const match = VARIANT.exec(id);
  if (!match?.[1] || match[2] === undefined) return { base: id, params: {} };
  const params: Params = {};
  for (const part of match[2].split(",")) {
    const [key, ...rest] = part.split("=");
    if (key?.trim()) params[key.trim()] = rest.join("=").trim() || "true";
  }
  return { base: match[1], params };
}

/** One family per base, in the agent's own order (Auto stays where the agent put it). */
export function modelFamilies(options: readonly ModelOption[]): ModelFamily[] {
  const families = new Map<string, ModelFamily>();
  for (const option of options) {
    const { base, params } = parseVariant(option.id);
    const family = families.get(base);
    const variant = { ...option, params };
    if (family) family.variants.push(variant);
    else families.set(base, { base, name: option.name, variants: [variant] });
  }
  for (const family of families.values()) {
    // The plain variant names the family when there is one (its name carries no variant text).
    const plain = family.variants.find((variant) => !Object.keys(variant.params).length);
    if (plain) family.name = plain.name;
  }
  return [...families.values()];
}

const isFlag = (value: string | undefined) => value === undefined || /^(true|false)$/u.test(value);
const flag = (value: string | undefined) => value === "true";

/** The switches the family of the current id offers: only between variants that exist. */
export function variantControls(family: ModelFamily, current: Variant): VariantControl[] {
  const keys = [...new Set(family.variants.flatMap((variant) => Object.keys(variant.params)))];
  return keys.flatMap((key): VariantControl[] => {
    const values = family.variants.map((variant) => variant.params[key]);
    if (values.every(isFlag)) {
      const states = new Set(values.map(flag));
      return states.size > 1 ? [{ key, kind: "toggle", on: flag(current.params[key]) }] : [];
    }
    const distinct = [...new Set(values.filter((value): value is string => !!value))];
    return distinct.length > 1
      ? [{ key, kind: "choice", value: current.params[key] ?? "", values: distinct }]
      : [];
  });
}

const same = (a: string | undefined, b: string | undefined) =>
  isFlag(a) && isFlag(b) ? flag(a) === flag(b) : a === b;

/**
 * The listed variant closest to `wanted` (the most keys match; `must` has to match), so turning
 * one switch keeps the others and switching models keeps Fast where the new model has it.
 */
export function closestVariant(family: ModelFamily, wanted: Params, must?: string): Variant {
  const pool = must
    ? family.variants.filter((variant) => same(variant.params[must], wanted[must]))
    : family.variants;
  const keys = new Set([
    ...Object.keys(wanted),
    ...family.variants.flatMap((variant) => Object.keys(variant.params)),
  ]);
  let best = (pool[0] ?? family.variants[0]) as Variant;
  let score = -1;
  for (const variant of pool) {
    let matches = 0;
    for (const key of keys) if (same(variant.params[key], wanted[key])) matches++;
    if (matches > score) {
      best = variant;
      score = matches;
    }
  }
  return best;
}
