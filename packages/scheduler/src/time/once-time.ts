import { type OnceTimeInput, OnceTimeInputSchema, type OnceTimeResult } from "@pibot/protocol-base";

// Work in wall-clock components, never let Date silently normalize a gap or choose a fold.
export function resolveOnceTime(input: OnceTimeInput, signal?: AbortSignal): OnceTimeResult {
  const { localTime, timezone, disambiguation } = OnceTimeInputSchema.parse(input);
  signal?.throwIfAborted();
  // Native datetime-local values omit trailing fractional zeros; restore exact milliseconds.
  const normalized =
    localTime.length === 16
      ? `${localTime}:00.000`
      : localTime.length === 19
        ? `${localTime}.000`
        : localTime.padEnd(23, "0");
  const target = Date.parse(`${normalized}Z`);
  const invalid: OnceTimeResult = { status: "invalid", at: null, candidates: [] };
  if (!Number.isFinite(target) || new Date(target).toISOString().slice(0, 23) !== normalized)
    return invalid;
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    calendar: "iso8601",
    numberingSystem: "latn",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
  const wall = (at: number) => {
    const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
    return Date.parse(
      `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}Z`,
    );
  };
  // All IANA offsets lie within 24 hours. Sampling both sides includes DST and date-line transitions.
  const offsets = new Set<number>();
  for (let h = -48; h <= 48; h++) {
    signal?.throwIfAborted();
    const at = target + h * 3600000;
    offsets.add(wall(at) - at);
  }
  const candidates = [...offsets]
    .map((offset) => ({
      at: new Date(target - offset).toISOString(),
      offsetMinutes: offset / 60000,
    }))
    .filter((c) => wall(Date.parse(c.at)) === target)
    .sort((a, b) => a.at.localeCompare(b.at));
  if (!candidates.length) return { status: "nonexistent", at: null, candidates: [] };
  if (candidates.length > 2) return invalid;
  if (candidates.length === 2 && !disambiguation)
    return { status: "ambiguous", at: null, candidates };
  return {
    status: "resolved",
    at: candidates[disambiguation === "later" ? candidates.length - 1 : 0]?.at ?? null,
    candidates,
  };
}
