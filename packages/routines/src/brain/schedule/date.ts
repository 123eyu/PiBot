import { RpcError } from "@pibot/protocol";

export function dateWindow(date: string, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const localDate = (at: number) => {
    const parts = formatter.formatToParts(at);
    const get = (kind: string) => parts.find((part) => part.type === kind)?.value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  };
  const boundary = (day: string, required: boolean) => {
    const utc = Date.parse(`${day}T00:00:00.000Z`);
    let low = utc - 172800000,
      high = utc + 172800000;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (localDate(mid) < day) low = mid + 1;
      else high = mid;
    }
    if (required && localDate(low) !== day)
      throw new RpcError(-32602, "Date does not exist in timezone");
    return new Date(low).toISOString();
  };
  const tomorrow = new Date(Date.parse(`${date}T00:00:00.000Z`) + 86400000)
    .toISOString()
    .slice(0, 10);
  return { from: boundary(date, true), to: boundary(tomorrow, false) };
}
