import { parsePushRequest, validateRoomTicket } from "@pibot/link/room";
import { readBody } from "../push/body.ts";
import { sendExpo } from "../push/expo.ts";
import { relayRole } from "../room/attachment.ts";
import { countConnection, readStats } from "../stats/stats.ts";
import { bounded } from "./deadline.ts";
import { connectionAllowed, pushAllowed } from "./limits.ts";
import type { RelayEnv } from "./types.ts";
export function createRelay(expoTransport: typeof fetch = fetch) {
  return {
    async fetch(request: Request, env: RelayEnv, ctx?: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
      try {
        if (url.pathname === "/push" && request.method === "POST") {
          if (!env.EXPO_ACCESS_TOKEN) return new Response(null, { status: 503 });

          let push: ReturnType<typeof parsePushRequest>;
          try {
            push = parsePushRequest(await readBody(request, signal));
          } catch {
            return new Response(null, { status: 400 });
          }
          if (!(await bounded(pushAllowed(push.room.roomId, env), signal)))
            return new Response(null, { status: 429 });
          const sent = await sendExpo(push, env.EXPO_ACCESS_TOKEN, signal, expoTransport);
          // 410 tells the desktop to forget this token (DeviceNotRegistered); no body either way.
          return new Response(null, {
            status: sent === "ok" ? 202 : sent === "unregistered" ? 410 : 502,
          });
        }
        if (url.pathname === "/_stats") return await readStats(request, env);
        const room = /^\/room\/([\w-]{43})$/.exec(url.pathname);
        if (!room || request.method !== "GET") return new Response(null, { status: 404 });
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
          return new Response(null, { status: 426 });
        const role = relayRole(url);
        if (!role) return new Response(null, { status: 400 });
        try {
          validateRoomTicket({
            roomId: room[1],
            credential: url.searchParams.get("credential"),
            period: Number(url.searchParams.get("period")),
          });
        } catch {
          return new Response(null, { status: 403 });
        }
        if (!(await bounded(connectionAllowed(request, env), signal)))
          return new Response(null, { status: 429 });
        const accepted = await bounded(
          env.ROOMS.get(env.ROOMS.idFromName(`room:${room[1]}`)).fetch(request),
          signal,
        );
        if (accepted.status === 101) countConnection(env, ctx, role.role, role.kind ?? "phone");
        return accepted;
      } catch (error) {
        // Workers Logs is on (maintainers 2026-11-17); without this a 503 shows no cause.
        console.error(
          "relay_unavailable",
          error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        );
        return new Response(null, { status: 503 });
      }
    },
  };
}
