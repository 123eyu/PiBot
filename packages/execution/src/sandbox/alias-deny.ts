import * as path from "node:path";

type PathRules = Pick<typeof path, "resolve" | "dirname" | "sep">;

/** Match lexical ancestors exactly as within(); resolving symlinks here would change deny scope. */
export function aliasDenyMatcher(denied: readonly string[], rules: PathRules = path) {
  const key = (value: string) => {
    const normalized = rules.resolve(value);
    return rules.sep === "\\" ? normalized.toLowerCase() : normalized;
  };
  const roots = new Set(denied.map(key));
  return (value: string) => {
    let current = key(value);
    for (;;) {
      if (roots.has(current)) return true;
      const parent = rules.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  };
}
