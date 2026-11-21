import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concat, EMPTY, LinkError, sequence, utf8 } from "../core/bytes.ts";
export function noiseKdf(key: Uint8Array, input: Uint8Array, count: number) {
  const prk = hmac(sha256, key, input);
  const result: Uint8Array[] = [];
  let previous: Uint8Array = EMPTY;
  for (let i = 1; i <= count; i++) {
    previous = hmac(sha256, prk, concat(previous, Uint8Array.of(i)));
    result.push(previous);
  }
  prk.fill(0);
  return result;
}
export class Cipher {
  private key?: Uint8Array;
  private n = 0n;
  constructor(key?: Uint8Array) {
    this.key = key?.slice();
  }
  reset(key: Uint8Array) {
    this.key?.fill(0);
    this.key = key.slice();
    this.n = 0n;
  }
  run(encrypt: boolean, data: Uint8Array, ad: Uint8Array = EMPTY) {
    if (!this.key) return data.slice();
    if (this.n >= 0xffffffffffffffffn) throw new LinkError("nonce_exhausted");
    const nonce = concat(new Uint8Array(4), sequence(this.n));
    try {
      const cipher = chacha20poly1305(this.key, nonce, ad);
      const result = encrypt ? cipher.encrypt(data) : cipher.decrypt(data);
      this.n++;
      return result;
    } catch {
      throw new LinkError("authentication_failed");
    }
  }
  dispose() {
    this.key?.fill(0);
    this.key = undefined;
  }
}
export class Symmetric {
  h: Uint8Array;
  private ck: Uint8Array;
  private cipher = new Cipher();
  constructor(pattern: "IK" | "IKpsk2", prologue: Uint8Array, responder: Uint8Array) {
    const name = utf8(`Noise_${pattern}_25519_ChaChaPoly_SHA256`);
    this.h = name.length <= 32 ? concat(name, new Uint8Array(32 - name.length)) : sha256(name);
    this.ck = this.h.slice();
    this.hash(prologue);
    this.hash(responder);
  }
  hash(data: Uint8Array) {
    this.h = sha256(concat(this.h, data));
  }
  mix(data: Uint8Array, psk = false) {
    const keys = noiseKdf(this.ck, data, psk ? 3 : 2);
    this.ck.fill(0);
    this.ck = keys[0] as Uint8Array;
    if (psk) {
      this.hash(keys[1] as Uint8Array);
      (keys[1] as Uint8Array).fill(0);
    }
    const key = keys[psk ? 2 : 1] as Uint8Array;
    this.cipher.reset(key);
    key.fill(0);
  }
  crypt(encrypt: boolean, data: Uint8Array) {
    const result = this.cipher.run(encrypt, data, this.h);
    this.hash(encrypt ? result : data);
    return result;
  }
  split() {
    return noiseKdf(this.ck, EMPTY, 2) as [Uint8Array, Uint8Array];
  }
  dispose() {
    this.ck.fill(0);
    this.cipher.dispose();
  }
}
