import { RtcStateSchema } from "@pibot/link";
import { StunUrlSchema } from "@pibot/remote-contract";
import { z } from "zod";

export const BRIDGE_PEERS = 32;
export const BRIDGE_REQUESTS = 64;
export const BRIDGE_FRAMES = 128;
export const BRIDGE_BUFFER = 2 * 1024 * 1024;
export const BRIDGE_FRAGMENT = 64 * 1024;
// link samples 2 MiB before a whole 1 MiB logical frame, including its fragment headers.
export const BRIDGE_SEND_BUFFER = BRIDGE_BUFFER + 1024 * 1024 + BRIDGE_FRAGMENT;
export const BRIDGE_TIMEOUT = 20_000;
const peer = z.uuid();
const counter = z.number().int().nonnegative().safe();
const sdp = z
  .string()
  .min(1)
  .max(128 * 1024);
const candidate = z.string().max(16 * 1024);
const frame = z.custom<Uint8Array>(
  (value) =>
    value instanceof Uint8Array && value.byteLength > 0 && value.byteLength <= BRIDGE_FRAGMENT,
);
export const ChannelStateSchema = z.enum(["connecting", "open", "closing", "closed"]);
export const BridgeOperationSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("create"),
    role: z.enum(["initiator", "responder"]),
    stunUrl: StunUrlSchema.optional(),
  }),
  z.strictObject({ type: z.literal("channel") }),
  z.strictObject({ type: z.literal("wait") }),
  z.strictObject({ type: z.literal("offer") }),
  z.strictObject({ type: z.literal("acceptOffer"), sdp }),
  z.strictObject({ type: z.literal("acceptAnswer"), sdp }),
  z.strictObject({ type: z.literal("candidate"), candidate }),
  z.strictObject({ type: z.literal("pathKind") }),
  // Answers PathStats (rtc-stats.ts) as JSON text; the brain parses it with PathStatsSchema.
  z.strictObject({ type: z.literal("pathStats") }),
]);
export const BridgeCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("request"),
    id: counter,
    peer,
    operation: BridgeOperationSchema,
  }),
  z.strictObject({ kind: z.literal("send"), peer, sequence: counter, frame }),
  z.strictObject({ kind: z.literal("received"), peer, bytes: counter, sequence: counter }),
  z.strictObject({ kind: z.literal("threshold"), peer, value: counter.max(BRIDGE_BUFFER) }),
  z.strictObject({ kind: z.literal("close"), peer }),
]);
export const BridgeEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("diagnostic"), peer, diagnostic: RtcStateSchema }),
  z.strictObject({
    kind: z.literal("result"),
    id: counter,
    peer,
    ok: z.boolean(),
    value: z.union([sdp, z.enum(["lan", "punched", "relay", "unknown"])]).optional(),
  }),
  z.strictObject({
    kind: z.literal("state"),
    peer,
    state: ChannelStateSchema,
    bufferedAmount: counter.max(BRIDGE_SEND_BUFFER),
    ackedBytes: counter,
    ackedSequence: counter,
  }),
  z.strictObject({ kind: z.literal("candidate"), peer, value: candidate }),
  z.strictObject({ kind: z.literal("frame"), peer, sequence: counter, frame }),
  z.strictObject({ kind: z.literal("closed"), peer, failed: z.boolean() }),
]);
export type BridgeCommand = z.infer<typeof BridgeCommandSchema>;
export type BridgeEvent = z.infer<typeof BridgeEventSchema>;
export type BridgeOperation = z.infer<typeof BridgeOperationSchema>;

export interface BridgePort {
  postMessage(value: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  off(event: "message", listener: (event: { data: unknown }) => void): unknown;
  off(event: "close", listener: () => void): unknown;
  start(): void;
  close(): void;
}
