import type { EventTable, MethodTable } from "@pibot/protocol";
import type { z } from "zod";

/**
 * The desktop updates itself while the phone app is updated by hand, so the phone often
 * reads data from a newer desktop. The shared schemas are mostly `strictObject`, which would turn
 * every field a newer desktop adds into a failed screen. `Lenient` derives, once per schema, a
 * copy that reads the same data the same way but
 *  - drops object keys it does not know (strict → strip; `looseObject` stays loose),
 *  - drops keys an enum-keyed record does not know,
 *  - drops array items that no longer parse (a new enum value, a new union kind) and reports
 *    each through `onSkip` instead of failing the whole list.
 * Refinements, checks, defaults and transforms are kept: the copy is built from each schema's own
 * definition with only the child schemas swapped. Everything else (enums, literals, primitives,
 * custom/transform) is used unchanged. Requests the phone sends keep the strict schemas, and the
 * desktop keeps validating phone requests strictly (the security boundary does not move).
 *
 * Built on zod 4's public-but-internal `_zod.def` / `_zod.constr` (the same path zod's own
 * `clone()` takes). A schema kind this does not know is returned as is, so a zod upgrade can only
 * make reading stricter again, never wrong; a contract probe covers it.
 */
export type Lenient = <T extends z.ZodType>(schema: T) => T;

type Def = Record<string, unknown> & { type: string };
type Schema = z.ZodType & {
  _zod: { def: Def; constr: new (def: Def) => z.ZodType; values?: Set<unknown> };
};
// A caught item becomes this marker and the array's last check filters it out.
const SKIPPED = Symbol("skipped");
// Wrappers whose only child is `innerType`.
const WRAPPERS = new Set([
  "optional",
  "nullable",
  "default",
  "prefault",
  "nonoptional",
  "readonly",
  "catch",
  "success",
]);

/** Same def with some fields replaced; accessors (an object's lazy shape) are copied as accessors. */
function rebuild(schema: Schema, changes: Record<string, unknown>) {
  const def = Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(schema._zod.def),
      ...Object.getOwnPropertyDescriptors(changes),
    },
  ) as Def;
  return new schema._zod.constr(def) as Schema;
}

export function createLenient(onSkip?: () => void): Lenient {
  const cache = new WeakMap<z.ZodType, z.ZodType>();
  const read = (input: z.ZodType): z.ZodType => {
    const hit = cache.get(input);
    if (hit) return hit;
    const schema = input as Schema;
    const def = schema._zod.def;
    let out: z.ZodType = schema;
    if (def.type === "object") out = object(schema);
    else if (def.type === "array") out = array(schema);
    else if (WRAPPERS.has(def.type))
      out = rebuild(schema, { innerType: read(def.innerType as z.ZodType) });
    else if (def.type === "union") out = union(schema);
    else if (def.type === "intersection")
      out = rebuild(schema, {
        left: read(def.left as z.ZodType),
        right: read(def.right as z.ZodType),
      });
    else if (def.type === "record") out = record(schema);
    else if (def.type === "map")
      out = rebuild(schema, {
        keyType: read(def.keyType as z.ZodType),
        valueType: read(def.valueType as z.ZodType),
      });
    else if (def.type === "set")
      out = rebuild(schema, { valueType: read(def.valueType as z.ZodType) });
    else if (def.type === "tuple")
      out = rebuild(schema, {
        items: (def.items as z.ZodType[]).map(read),
        rest: def.rest ? read(def.rest as z.ZodType) : def.rest,
      });
    else if (def.type === "lazy") {
      const getter = def.getter as () => z.ZodType;
      // Deferred like the original, so recursive schemas resolve through the cache. zod keeps the
      // resolved inner schema on the def (`_cachedInner`); the copy must not inherit the strict one.
      out = rebuild(schema, { getter: () => read(getter()), _cachedInner: undefined });
    } else if (def.type === "pipe")
      out = rebuild(schema, { in: read(def.in as z.ZodType), out: read(def.out as z.ZodType) });
    cache.set(input, out);
    return out;
  };
  function object(schema: Schema) {
    const def = schema._zod.def;
    const shape = def.shape as Record<string, z.ZodType>;
    const next = {};
    // Getters: zod freezes a shape on its first read (at the first parse), so children convert
    // lazily and a schema reachable from itself meets its own cache entry.
    for (const key of Object.keys(shape))
      Object.defineProperty(next, key, {
        enumerable: true,
        get: () => read(shape[key] as z.ZodType),
      });
    const catchall = def.catchall as Schema | undefined;
    return rebuild(schema, {
      shape: next,
      // strictObject = catchall never; without a catchall zod strips unknown keys.
      catchall:
        !catchall || catchall._zod.def.type === "never" ? undefined : read(catchall as z.ZodType),
    });
  }
  function array(schema: Schema) {
    const element = read(schema._zod.def.element as z.ZodType).catch(() => {
      onSkip?.();
      return SKIPPED as never;
    });
    return rebuild(schema, { element }).overwrite((value) => {
      const items = value as unknown[];
      return items.includes(SKIPPED) ? items.filter((item) => item !== SKIPPED) : items;
    });
  }
  function union(schema: Schema) {
    const def = schema._zod.def;
    const options = def.options as z.ZodType[];
    // A discriminated union picks by its key (duplicate keys would throw), an exclusive one
    // must match one option only: both just read every option leniently.
    if (def.discriminator !== undefined || def.inclusive === false)
      return rebuild(schema, { options: options.map(read) });
    // A plain union takes the first option that parses, and strictness may be what tells its
    // options apart. Known data still meets the original options first; only data no option
    // accepts strictly falls through to the lenient ones, widest object first, so dropping an
    // unknown key never lets a narrower option swallow a wider one's fields.
    const width = (option: z.ZodType) => {
      const d = (option as Schema)._zod.def;
      return d.type === "object" ? Object.keys(d.shape as object).length : 0;
    };
    const fallbacks = options.map(read).sort((a, b) => width(b) - width(a));
    return rebuild(schema, { options: [...options, ...fallbacks] });
  }
  function record(schema: Schema) {
    const def = schema._zod.def;
    const valueType = read(def.valueType as z.ZodType);
    const known = (def.keyType as Schema)._zod.values;
    if (!known) return rebuild(schema, { valueType });
    // An enum-keyed record rejects keys outside its enum; let them through, then drop them.
    const keys = new Set([...known].map(String));
    return rebuild(schema, { valueType, mode: "loose" }).overwrite((value) => {
      const entries = value as Record<string, unknown>;
      for (const key of Object.keys(entries)) if (!keys.has(key)) delete entries[key];
      return entries;
    });
  }
  return read as Lenient;
}

/**
 * A method table whose results (what the desktop answers) read leniently; params stay strict.
 * Entries convert on first use, so a table of hundreds of methods costs nothing up front.
 */
export function lenientMethods<M extends MethodTable>(methods: M, lenient: Lenient): M {
  const table = {} as M;
  for (const key of Object.keys(methods)) {
    const strict = methods[key] as M[string];
    let entry: M[string] | undefined;
    Object.defineProperty(table, key, {
      enumerable: true,
      get: () => {
        entry ??= { ...strict, result: lenient(strict.result) };
        return entry;
      },
    });
  }
  return table;
}
/** An event table whose payloads (all sent by the desktop) read leniently. */
export function lenientEvents<E extends EventTable>(events: E, lenient: Lenient): E {
  const table = {} as E;
  for (const key of Object.keys(events))
    Object.defineProperty(table, key, {
      enumerable: true,
      get: () => lenient(events[key] as z.ZodType),
    });
  return table;
}
