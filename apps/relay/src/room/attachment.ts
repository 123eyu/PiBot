import { roomPeriod } from "@pibot/link/room";
export interface Connection {
  role: "desktop" | "phone" | "runner";
  kind?: "phone" | "runner";
  peer?: string;
  roomId: string;
  period: number;
  /** Accept time (ms); sockets accepted before this field existed have none. */
  at?: number;
}
export function connection(ws: WebSocket): Connection | undefined {
  const value: unknown = ws.deserializeAttachment();
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (
    (v.role !== "desktop" && v.role !== "phone" && v.role !== "runner") ||
    (v.kind !== undefined && v.kind !== "phone" && v.kind !== "runner") ||
    ((v.kind === "runner" || v.role === "runner") &&
      (typeof v.peer !== "string" || !/^[a-f0-9]{64}$/.test(v.peer))) ||
    typeof v.roomId !== "string" ||
    !/^[\w-]{43}$/.test(v.roomId) ||
    v.period !== roomPeriod()
  )
    return;
  return {
    role: v.role,
    roomId: v.roomId,
    period: v.period,
    kind: v.kind ?? "phone",
    ...(typeof v.peer === "string" ? { peer: v.peer } : {}),
    ...(Number.isSafeInteger(v.at) ? { at: v.at as number } : {}),
  };
}
export function relayRole(url: URL) {
  const role = url.searchParams.get("role");
  const kind = url.searchParams.get("kind") ?? "phone";
  const peer = url.searchParams.get("peer");
  if (
    (role !== "desktop" && role !== "phone" && role !== "runner") ||
    (kind !== "phone" && kind !== "runner") ||
    (role === "phone" && kind !== "phone") ||
    (role === "runner" && kind !== "runner") ||
    (kind === "runner" && (!peer || !/^[a-f0-9]{64}$/.test(peer))) ||
    (kind === "phone" && peer !== null) ||
    [...url.searchParams.keys()].some(
      (key) => !["credential", "period", "role", "kind", "peer"].includes(key),
    ) ||
    url.searchParams.size !== (kind === "runner" ? 5 : url.searchParams.has("kind") ? 4 : 3)
  )
    return;
  return { role, kind, ...(peer ? { peer } : {}) } as Pick<Connection, "role" | "kind" | "peer">;
}
/** Sent to a phone socket superseded by a newer authenticated connection from the same room. */
export const REPLACED_CLOSE = 4001;
export function closeSocket(ws: WebSocket, code = 1000) {
  try {
    ws.close(code, "closed");
  } catch {
    /* The runtime may already have retired this socket; no application resource remains. */
  }
}
