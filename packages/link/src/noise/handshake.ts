import { x25519 } from "@noble/curves/ed25519.js";
import {
  concat,
  EMPTY,
  equal,
  LinkError,
  type RandomBytes,
  requireBytes,
  utf8,
} from "../core/bytes.ts";
import { NoiseChannel } from "./channel.ts";
import { Symmetric } from "./symmetric.ts";
export interface HandshakeOptions {
  role: "initiator" | "responder";
  staticSecret: Uint8Array;
  remoteStatic?: Uint8Array;
  psk?: Uint8Array;
  random: RandomBytes;
  prologue?: Uint8Array;
  ephemeralSecret?: Uint8Array;
}
// Only IK/IKpsk2 are supported. Early payloads are identity metadata, never business RPC.
export class NoiseHandshake {
  private symmetric: Symmetric;
  private s: Uint8Array;
  private e: Uint8Array;
  private remoteE?: Uint8Array;
  private remoteS?: Uint8Array;
  private expected?: Uint8Array;
  private psk?: Uint8Array;
  private step = 0;
  private closed = false;
  private readonly role: HandshakeOptions["role"];
  constructor(options: HandshakeOptions) {
    this.role = options.role;
    this.s = requireBytes(options.staticSecret, 32).slice();
    this.e = requireBytes(options.ephemeralSecret ?? options.random(32), 32).slice();
    this.expected = options.remoteStatic?.slice();
    this.remoteS = this.expected?.slice();
    this.psk = options.psk ? requireBytes(options.psk, 32).slice() : undefined;
    const responder =
      options.role === "initiator"
        ? requireBytes(options.remoteStatic as Uint8Array, 32)
        : x25519.getPublicKey(this.s);
    this.symmetric = new Symmetric(
      this.psk ? "IKpsk2" : "IK",
      options.prologue ?? utf8("pibot-link-v1"),
      responder,
    );
  }
  private dh(secret: Uint8Array, publicKey: Uint8Array | undefined) {
    if (!publicKey) throw new LinkError("handshake_order");
    const shared = x25519.getSharedSecret(secret, publicKey);
    try {
      this.symmetric.mix(shared);
    } finally {
      shared.fill(0);
    }
  }
  private ephemeral(key: Uint8Array) {
    this.symmetric.hash(key);
    if (this.psk) this.symmetric.mix(key);
  }
  write(payload: Uint8Array = EMPTY) {
    return this.guard(() => {
      if (payload.length > 4096) throw new LinkError("handshake_payload_too_large");
      const initiator = this.role === "initiator";
      if (this.step !== (initiator ? 0 : 1)) throw new LinkError("handshake_order");
      const ephemeral = x25519.getPublicKey(this.e);
      this.ephemeral(ephemeral);
      const parts = [ephemeral];
      if (initiator) {
        this.dh(this.e, this.remoteS);
        parts.push(this.symmetric.crypt(true, x25519.getPublicKey(this.s)));
        this.dh(this.s, this.remoteS);
      } else {
        this.dh(this.e, this.remoteE);
        this.dh(this.e, this.remoteS);
        if (this.psk) this.symmetric.mix(this.psk, true);
      }
      parts.push(this.symmetric.crypt(true, payload));
      this.step++;
      return concat(...parts);
    });
  }
  read(message: Uint8Array) {
    return this.guard(() => {
      const initiator = this.role === "initiator";
      if (
        this.step !== (initiator ? 1 : 0) ||
        message.length < (initiator ? 48 : 96) ||
        message.length > 4200
      )
        throw new LinkError("invalid_handshake");
      this.remoteE = message.slice(0, 32);
      this.ephemeral(this.remoteE);
      let offset = 32;
      if (initiator) {
        this.dh(this.e, this.remoteE);
        this.dh(this.s, this.remoteE);
        if (this.psk) this.symmetric.mix(this.psk, true);
      } else {
        this.dh(this.s, this.remoteE);
        this.remoteS = this.symmetric.crypt(false, message.subarray(32, 80));
        offset = 80;
        if (this.expected && !equal(this.expected, this.remoteS))
          throw new LinkError("peer_revoked");
        this.dh(this.s, this.remoteS);
      }
      const payload = this.symmetric.crypt(false, message.subarray(offset));
      this.step++;
      return payload;
    });
  }
  finish() {
    return this.guard(() => {
      if (this.step !== 2 || !this.remoteS) throw new LinkError("handshake_incomplete");
      const [a, b] = this.symmetric.split();
      const initiator = this.role === "initiator";
      const channel = new NoiseChannel(
        initiator ? a : b,
        initiator ? b : a,
        this.symmetric.h,
        this.remoteS,
      );
      a.fill(0);
      b.fill(0);
      this.dispose();
      return channel;
    });
  }
  private guard<T>(operation: () => T): T {
    if (this.closed) throw new LinkError("handshake_closed");
    try {
      return operation();
    } catch {
      this.dispose();
      throw new LinkError("handshake_failed");
    }
  }
  dispose() {
    this.closed = true;
    this.s.fill(0);
    this.e.fill(0);
    this.psk?.fill(0);
    this.symmetric.dispose();
  }
}
