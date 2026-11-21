import type { Port } from "@pibot/protocol-base";
import { z } from "zod";
import { type RandomBytes, unbase64 } from "../core/bytes.ts";
import type { EndpointKeys } from "../keys/endpoint.ts";
import { dhPublic } from "../keys/endpoint.ts";
import { PathSignaling } from "./path-signaling.ts";
import { encryptedPort } from "./port.ts";
import type { DirectDiagnosticSink } from "./rtc-diagnostics.ts";
import { admitRunnerPort } from "./runner-direct.ts";
import { establishDirectNoise, negotiateDirect, type RtcPeerFactory } from "./upgrade.ts";

export const RunnerPunchRequestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  method: z.literal("link.runner.punch"),
  params: z.strictObject({
    id: z.string().regex(/^[a-f0-9]{32}$/),
    stunUrl: z
      .string()
      .max(2048)
      .refine((value) => {
        const match = /^stun:(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(value);
        if (!match || (match[2] && (+match[2] < 1 || +match[2] > 65535))) return false;
        try {
          return !!new URL(`http://${match[1]}`).hostname;
        } catch {
          return false;
        }
      }),
  }),
});
export function isRunnerPunchMessage(value: unknown) {
  const method = (value as { method?: unknown } | null)?.method;
  return (
    method === "link.runner.punch" ||
    method === "link.runner.punch.signal" ||
    method === "link.runner.punch.unsupported"
  );
}

/** Only the authenticated relay carries this attempt's bounded signaling, never business RPC. */
export async function connectRunnerPunch(options: {
  port: Port;
  id: string;
  stunUrl: string;
  keys: EndpointKeys;
  publicKey: string;
  role: "initiator" | "responder";
  signal: AbortSignal;
  random: RandomBytes;
  createPeer: RtcPeerFactory;
  onDiagnostic?: DirectDiagnosticSink;
}) {
  const signaling = new PathSignaling({
    enabled: () => true,
    offer() {},
    control() {},
    fail() {
      stop.abort();
    },
  });
  const stop = new AbortController();
  const signal = AbortSignal.any([options.signal, stop.signal]);
  const envelope = z.strictObject({
    jsonrpc: z.literal("2.0"),
    method: z.literal("link.runner.punch.signal"),
    params: z.strictObject({
      id: z.literal(options.id),
      message: z.record(z.string(), z.unknown()),
    }),
  });
  const unsupported = z.strictObject({
    jsonrpc: z.literal("2.0"),
    method: z.literal("link.runner.punch.unsupported"),
    params: z.strictObject({ id: z.literal(options.id) }),
  });
  const off = options.port.onMessage((value) => {
    if (unsupported.safeParse(value).success) {
      stop.abort();
      return;
    }
    const parsed = envelope.safeParse(value);
    if (parsed.success) signaling.receive(parsed.data.params.message);
  });
  const raw: Port = {
    post(message) {
      options.port.post({
        jsonrpc: "2.0",
        method: "link.runner.punch.signal",
        params: { id: options.id, message },
      });
    },
    onMessage: () => () => {},
  };
  try {
    const data = await negotiateDirect({
      port: signaling.port(raw),
      role: options.role,
      signal,
      createPeer: (input) => options.createPeer({ ...input, stunUrl: options.stunUrl }),
      onDiagnostic: options.onDiagnostic,
    });
    const { transport, channel } = await establishDirectNoise(data, {
      role: options.role,
      staticSecret: options.keys.dhSecret,
      remoteStatic: dhPublic(unbase64(options.publicKey, 32)),
      random: options.random,
      signal,
    });
    const port = encryptedPort(channel, transport, { signal });
    return admitRunnerPort(
      port,
      transport.closed,
      async () => {
        port.dispose?.();
        stop.abort();
      },
      options.role,
    );
  } catch (error) {
    stop.abort();
    throw error;
  } finally {
    off();
    signaling.reset();
  }
}
