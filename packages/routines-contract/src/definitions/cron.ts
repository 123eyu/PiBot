/** Cheap field feedback; the scheduler remains authoritative for dates, DST and spacing. */
export function cronFieldIssue(
  expr: string,
): "syntax" | "minute" | "hour" | "day" | "month" | "weekday" | undefined {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return "syntax";
  const bounds = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ] as const;
  const names = ["minute", "hour", "day", "month", "weekday"] as const;
  for (const [i, field] of fields.entries()) {
    const bound = bounds[i];
    if (!bound) return "syntax";
    for (const part of field.split(",")) {
      const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
      if (!match) return "syntax";
      if (match[2] !== undefined && (!Number.isSafeInteger(+match[2]) || +match[2] < 1))
        return names[i];
      if (match[1] !== "*") {
        const [start, end = start] = (match[1] ?? "").split("-").map(Number);
        if (
          start === undefined ||
          end === undefined ||
          start < bound[0] ||
          end > bound[1] ||
          start > end
        )
          return names[i];
      }
    }
  }
}
