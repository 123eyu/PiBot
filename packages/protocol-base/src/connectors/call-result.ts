/** Metadata projection only; never return source text or infer a count from truncated output. */
export function connectorResultCount(value: unknown): number | null {
  for (let depth = 0; depth < 4; depth++) {
    if (Array.isArray(value)) return value.length;
    if (!value || typeof value !== "object") return null;
    const item = value as Record<string, unknown>;
    if (item.isError === true || item.ok === false) return null;
    for (const key of ["items", "contacts", "events"]) {
      if (Array.isArray(item[key])) return item[key].length;
    }
    if (item.ok === true && item.value !== undefined) value = item.value;
    else if (Array.isArray(item.content) && item.content.length === 1) {
      const part = item.content[0] as { type?: unknown; text?: unknown } | undefined;
      if (part?.type !== "text" || typeof part.text !== "string" || part.text.length > 1_048_576)
        return null;
      try {
        value = JSON.parse(part.text);
      } catch {
        return null;
      }
    } else return null;
  }
  return null;
}
