const PLACEHOLDER = "[redaction failed]";
const MAX_DEPTH = 64;
const MAX_NODES = 20_000;

/** Ordinary tool data only; assistant/history rewriting is intentionally absent. */
export function redactValue<T>(value: T, redact: (text: string) => string): T {
  let nodes = 0;
  const text = (value: string) => {
    try {
      return redact(value);
    } catch {
      return PLACEHOLDER;
    }
  };
  const visit = (current: unknown, depth: number): unknown => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) return PLACEHOLDER;
    if (typeof current === "string") return text(current);
    if (typeof current === "number") {
      const safe = text(String(current));
      return safe === String(current) ? current : safe;
    }
    if (Array.isArray(current)) return current.map((item) => visit(item, depth + 1));
    if (current && typeof current === "object")
      return Object.fromEntries(
        Object.entries(current).map(([key, item]) => [text(key), visit(item, depth + 1)]),
      );
    return current;
  };
  return visit(value, 0) as T;
}
