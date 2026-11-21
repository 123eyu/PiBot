import { CalendarDraftContentSchema } from "@pibot/protocol-base";
import { z } from "zod";
import { ConnectorToolError } from "../../runtime/tools/connectors/connector-tools.ts";

const localTime = z.iso.datetime({ local: true }).max(64);
const hour = 3_600_000;

/** Round-trip candidates instead of letting Date silently choose a DST fold or skip a gap. */
function timestamp(value: unknown, timeZone: string): string {
  if (CalendarDraftContentSchema.shape.start.safeParse(value).success) return value as string;
  if (typeof value !== "string" || !localTime.safeParse(value).success)
    throw new ConnectorToolError("calendar_time_invalid");
  const local = Date.parse(`${value}Z`);
  if (!Number.isFinite(local)) throw new ConnectorToolError("calendar_time_invalid");
  const offsets = new Set<number>();
  const format = new Intl.DateTimeFormat("en", { timeZone, timeZoneName: "longOffset" });
  // A civil time can straddle a transition (including a whole skipped day). Observe both sides;
  // only offsets that round-trip at the candidate instant are accepted, never a guessed offset.
  const offsetAt = (instant: number) => {
    const name = format.formatToParts(instant).find((part) => part.type === "timeZoneName")?.value;
    if (name === "GMT") return 0;
    const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name ?? "");
    if (!match) throw new ConnectorToolError("calendar_time_zone_unavailable");
    return (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
  };
  for (let delta = -36; delta <= 36; delta += 6) offsets.add(offsetAt(local + delta * hour));
  const matches = [...offsets].filter((offset) => offsetAt(local - offset * 60_000) === offset);
  if (!matches.length) throw new ConnectorToolError("calendar_time_nonexistent");
  if (matches.length !== 1) throw new ConnectorToolError("calendar_time_ambiguous");
  const offset = matches[0] as number;
  const magnitude = Math.abs(offset);
  const suffix = `${offset < 0 ? "-" : "+"}${String(Math.floor(magnitude / 60)).padStart(2, "0")}:${String(magnitude % 60).padStart(2, "0")}`;
  return `${value}${suffix}`;
}

/** The zone is captured once for both endpoints and persisted with the immutable draft. */
export function calendarTimes(
  args: Record<string, unknown>,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
) {
  try {
    if (!timeZone) throw new ConnectorToolError("calendar_time_zone_unavailable");
    new Intl.DateTimeFormat("en", { timeZone }).format(0);
    const start = timestamp(args.start, timeZone);
    const end = timestamp(args.end, timeZone);
    if (Date.parse(end) <= Date.parse(start)) throw new ConnectorToolError("calendar_time_order");
    return { start, end, timeZone };
  } catch (error) {
    if (error instanceof ConnectorToolError) throw error;
    throw new ConnectorToolError("calendar_time_zone_unavailable");
  }
}
