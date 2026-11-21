import type { MethodResults } from "@pibot/protocol";
import type { Peer } from "@pibot/renderer-kit";
import { useCallback } from "react";
import { useCursorPages } from "../page/cursor-pages.ts";

type PowerPage = Extract<MethodResults["routines.timeline"], { source: "power" }>;
export type PlannedPoint = MethodResults["routines.planned"]["points"][number];
const pointKey = (point: PlannedPoint) => `${point.at}/${point.routineId}`;
const eventKey = (event: PowerPage["events"][number]) => event.id;
type PlannedWindow = Pick<MethodResults["routines.planned"], "from" | "to" | "asOf">;
const sameWindow = (a: PlannedWindow, b: PlannedWindow) => a.from === b.from && a.to === b.to;
const samePower = (a: PowerPage["context"], b: PowerPage["context"]) =>
  a.state === b.state && a.event?.id === b.event?.id && a.event?.at === b.event?.at;

export function usePlanned(date: string, timezone: string) {
  const load = useCallback(
    async (peer: Peer, cursor?: NonNullable<MethodResults["routines.planned"]["nextCursor"]>) => {
      const page = await peer.call("routines.planned", { date, timezone, cursor, limit: 50 });
      if (new Date(page.to) <= new Date(page.from)) throw new Error("Invalid timeline window");
      if (page.points.some((point) => point.at < page.from || point.at >= page.to))
        throw new Error("Planned point outside timeline");
      return {
        items: page.points,
        cursor: page.nextCursor ?? undefined,
        meta: { from: page.from, to: page.to, asOf: page.asOf },
      };
    },
    [date, timezone],
  );
  return useCursorPages(load, pointKey, sameWindow, { refreshLoadedPages: true });
}

export function usePower(date: string, timezone: string) {
  const load = useCallback(
    async (peer: Peer, before?: string) => {
      const page = await peer.call("routines.timeline", {
        date,
        timezone,
        source: "power",
        before,
        limit: 50,
      });
      if (page.source !== "power") throw new Error("Timeline source mismatch");
      return {
        items: page.events,
        cursor: page.events.length === 50 ? page.events.at(-1)?.id : undefined,
        meta: page.context,
      };
    },
    [date, timezone],
  );
  return useCursorPages(load, eventKey, samePower);
}

export function powerIntervals(
  context: PowerPage["context"],
  events: PowerPage["events"],
  from: string,
  until: string,
) {
  const segments: { from: string; to: string; state: "suspended" | "unknown" }[] = [];
  let state = context.state;
  let cursor = from;
  for (const event of [...events].sort((a, b) => a.at.localeCompare(b.at))) {
    if (event.at < from || event.at > until) continue;
    if (event.kind !== "suspend" && event.kind !== "resume" && event.kind !== "start") continue;
    if (state !== "awake" && event.at > cursor)
      segments.push({ from: cursor, to: event.at, state });
    state = event.kind === "suspend" ? "suspended" : "awake";
    cursor = event.at;
  }
  if (cursor < until && state !== "awake") segments.push({ from: cursor, to: until, state });
  return segments;
}
