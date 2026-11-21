import { base64url, type RandomBytes, unbase64 } from "../core/bytes.ts";
import type { EndpointKeys } from "../keys/endpoint.ts";
import { runnerDeviceId } from "../room/runner.ts";
import { roomTicket } from "../room/ticket.ts";
import { firstConnection, lanToken } from "../transport/lan.ts";
import { openRunnerRelay } from "../transport/runner-relay.ts";
import type { SocketConstructor } from "../transport/socket.ts";
import type { RtcPeerFactory } from "../transport/upgrade.ts";
import { assertPhoneControlCurrent, verifyPhoneControl } from "./phone-control.ts";
import { discoverPhoneRunner, type PhoneRunnerDiscover } from "./phone-runner-lan.ts";
import { phoneRunnerPath } from "./phone-runner-path.ts";
import { connectRunnerSession, runnerRoomKey } from "./runner-session.ts";

/** T2 injects the phone identity from its existing secure credential, never a model API key. */
export async function openPhoneRunnerSession(options: {
  discover?: PhoneRunnerDiscover;
  createPeer?: RtcPeerFactory;
  keys: EndpointKeys;
  grant: unknown;
  issuer: string;
  relay: string;
  WebSocket: SocketConstructor;
  random: RandomBytes;
  signal: AbortSignal;
}) {
  const grant = verifyPhoneControl(options.grant, options.issuer);
  if (grant.body.phone !== base64url(options.keys.signingPublic))
    throw new Error("authorization_identity_mismatch");
  assertPhoneControlCurrent(grant);
  const key = runnerRoomKey(options.keys, grant.body.runner, grant.body.rotation);
  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(grant.body.expiresAt - Date.now()),
  ]);
  let room: Awaited<ReturnType<typeof openRunnerRelay>> | undefined;
  const instance = runnerDeviceId(unbase64(grant.body.rotation, 32)).slice(0, 32);
  const token = lanToken(key, instance);
  const relay = async (branchSignal: AbortSignal) => {
    try {
      if (options.discover)
        await new Promise<void>((yes, no) => {
          const done = () => {
            clearTimeout(timer);
            branchSignal.removeEventListener("abort", cancelled);
            yes();
          };
          const cancelled = () => {
            clearTimeout(timer);
            branchSignal.removeEventListener("abort", cancelled);
            no(new Error("phone_connection_cancelled"));
          };
          const timer = setTimeout(done, 3000);
          branchSignal.addEventListener("abort", cancelled, { once: true });
          if (branchSignal.aborted) cancelled();
        });
      const ticket = roomTicket(key);
      room = await openRunnerRelay({
        WebSocket: options.WebSocket,
        relay: options.relay,
        ticket,
        role: "desktop",
        slot: runnerDeviceId(unbase64(ticket.roomId, 32)),
        signal: branchSignal,
        peerTimeoutMs: 5000,
      });
      const active = AbortSignal.any([branchSignal, room.signal]);
      const port = await connectRunnerSession({
        transport: room.transport,
        keys: options.keys,
        publicKey: grant.body.runner,
        role: "responder",
        random: options.random,
        signal: active,
        timeoutMs: 5000,
        authorizationSignature: grant.signature,
      });
      assertPhoneControlCurrent(grant);
      const selected = await phoneRunnerPath({
        port,
        signal: active,
        keys: options.keys,
        grant,
        role: "responder",
        random: options.random,
        createPeer: options.createPeer,
      });
      return {
        ...selected,
        close: async () => {
          await selected.close();
          await room?.close();
        },
      };
    } catch (error) {
      await room?.close();
      throw error;
    }
  };
  try {
    return await firstConnection<{
      port: import("@pibot/protocol-base").Port;
      signal: AbortSignal;
      path: "lan" | "punched" | "relay";
      close(): Promise<void>;
    }>(
      [
        ...(options.discover
          ? [
              (branchSignal: AbortSignal) =>
                discoverPhoneRunner({
                  instance,
                  token,
                  discover: options.discover as PhoneRunnerDiscover,
                  WebSocket: options.WebSocket,
                  keys: options.keys,
                  runner: grant.body.runner,
                  signature: grant.signature,
                  random: options.random,
                  signal: branchSignal,
                }),
            ]
          : []),
        relay,
      ],
      signal,
    );
  } finally {
    key.fill(0);
  }
}
