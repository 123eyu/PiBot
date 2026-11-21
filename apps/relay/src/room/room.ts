import { DurableObject } from "cloudflare:workers";
import {
  MAX_FRAME,
  RUNNER_ROUTE_BYTES,
  readRunnerRoute,
  runnerRoute,
  validateRoomTicket,
} from "@pibot/link/room";
import type { RelayEnv } from "../worker/types.ts";
import {
  type Connection,
  closeSocket,
  connection,
  REPLACED_CLOSE,
  relayRole,
} from "./attachment.ts";
import { MinuteLimit } from "./limit.ts";

/**
 * Every relay client pings each 25 s and the runtime answers without waking the room, recording
 * the time. Three missed pings mean the client is gone even though the socket still reads OPEN.
 */
const STALE_MS = 75_000;
export class Room extends DurableObject<RelayEnv> {
  private readonly connections = new MinuteLimit();
  private readonly pushes = new MinuteLimit();
  constructor(ctx: DurableObjectState, env: RelayEnv) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("pibot:ping", "pibot:pong"));
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/_ip" && request.method === "POST")
      return new Response(null, { status: this.connections.take(60) ? 204 : 429 });
    if (url.pathname === "/_push" && request.method === "POST")
      return new Response(null, { status: this.pushes.take(30) ? 204 : 429 });
    if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response(null, { status: 426 });
    const match = /^\/room\/([\w-]{43})$/.exec(url.pathname),
      parsed = relayRole(url);
    if (!match || !parsed) return new Response(null, { status: 400 });
    const { role } = parsed;
    let ticket: ReturnType<typeof validateRoomTicket>;
    try {
      ticket = validateRoomTicket({
        roomId: match[1],
        credential: url.searchParams.get("credential"),
        period: Number(url.searchParams.get("period")),
      });
    } catch {
      return new Response(null, { status: 403 });
    }
    // The ticket above already proved this phone holds the room credential: the room ID commits
    // to it for the period. After a network change the previous socket can stay OPEN here with
    // no client behind it, and refusing with 409 locked the phone out until it timed out. Only an
    // authenticated phone for the same room and period replaces it; nothing else ever reaches it.
    // A desktop was never replaced, so one that vanished without closing (sleep, network change)
    // kept its own reconnects at 409 until the day's room expired (CN user, 2026-11-17). Only a
    // desktop socket that stopped answering pings gives way; a live second desktop still gets 409.
    const now = Date.now();
    const replaced =
      role === "phone" || role === "runner"
        ? this.live(role).filter((ws) => {
            const old = connection(ws);
            return (
              old?.roomId === ticket.roomId &&
              old.period === ticket.period &&
              (role === "phone" || old.peer === parsed.peer)
            );
          })
        : this.live(role).filter(
            (ws) => connection(ws)?.kind === parsed.kind && this.stale(ws, now),
          );
    if (
      role === "runner"
        ? this.live(role).length - replaced.length >= 8
        : this.live(role).length > replaced.length
    )
      return new Response(null, { status: 409 });
    if (replaced.length) {
      for (const ws of replaced) closeSocket(ws, REPLACED_CLOSE);
      // The other side drops its session on offline and waits for the newcomer's handshake.
      const others =
        role === "desktop" ? [...this.live("phone"), ...this.live("runner")] : this.live("desktop");
      for (const peer of others) this.sendControl(peer, false);
    }
    const pair = new WebSocketPair(),
      client = pair[0],
      server = pair[1];
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({
      role,
      kind: parsed.kind,
      ...(parsed.peer ? { peer: parsed.peer } : {}),
      roomId: ticket.roomId,
      period: ticket.period,
      at: now,
    } satisfies Connection);
    const others =
      role === "desktop" ? [...this.live("phone"), ...this.live("runner")] : this.live("desktop");
    this.sendControl(server, others.length > 0);
    for (const peer of others) this.sendControl(peer, true);
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const source = connection(ws);
    if (!source) {
      closeSocket(ws, 1008);
      return;
    }
    if (
      typeof message === "string" ||
      message.byteLength > MAX_FRAME + (source.role === "desktop" ? RUNNER_ROUTE_BYTES : 0)
    ) {
      closeSocket(ws, typeof message === "string" ? 1003 : 1009);
      this.offline(source.role);
      return;
    }
    let data: Uint8Array = new Uint8Array(message);
    let peers: WebSocket[];
    if (source.role === "desktop") {
      const routed = readRunnerRoute(data);
      if (routed) {
        data = routed.frame;
        peers = this.live("runner").filter((ws) => connection(ws)?.peer === routed.slot);
      } else {
        if (data.length > MAX_FRAME) {
          closeSocket(ws, 1009);
          return;
        }
        peers = this.live("phone");
      }
    } else {
      peers = this.live("desktop");
      if (source.role === "runner") data = runnerRoute(source.peer as string, data);
    }
    for (const peer of peers) {
      try {
        peer.send(data);
      } catch {
        closeSocket(peer, 1011);
        this.offline(source.role === "desktop" ? "phone" : "desktop");
      }
    }
  }
  webSocketClose(ws: WebSocket) {
    const source = connection(ws);
    closeSocket(ws);
    if (source) this.offline(source.role);
  }
  webSocketError(ws: WebSocket) {
    const source = connection(ws);
    closeSocket(ws, 1011);
    if (source) this.offline(source.role);
  }
  private stale(ws: WebSocket, now: number) {
    const pong = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
    return now - Math.max(pong, connection(ws)?.at ?? 0) > STALE_MS;
  }
  private live(role: Connection["role"]) {
    return this.ctx.getWebSockets(role).filter((ws) => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      if (!connection(ws)) {
        closeSocket(ws, 1008);
        return false;
      }
      return true;
    });
  }
  private offline(role: Connection["role"]) {
    const online =
      role === "desktop"
        ? this.live(role).length > 0
        : this.live("phone").length + this.live("runner").length > 0;
    const peers =
      role === "desktop" ? [...this.live("phone"), ...this.live("runner")] : this.live("desktop");
    for (const peer of peers) this.sendControl(peer, online);
  }
  private sendControl(ws: WebSocket, _online: boolean) {
    try {
      const source = connection(ws);
      const online =
        source?.role === "desktop"
          ? source.kind === "runner"
            ? this.live("runner").some((peer) => connection(peer)?.peer === source.peer)
            : this.live("phone").length > 0
          : this.live("desktop").length > 0;
      ws.send(online ? "pibot:online" : "pibot:offline");
    } catch {
      closeSocket(ws, 1011);
    }
  }
}
