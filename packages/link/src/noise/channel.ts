import {
  concat,
  equal,
  LinkError,
  MAX_FRAME,
  MAX_PLAINTEXT,
  readSequence,
  sequence,
} from "../core/bytes.ts";
import { Cipher } from "./symmetric.ts";
export class NoiseChannel {
  private tx: Cipher;
  private rx: Cipher;
  private sent = 0n;
  private received = 0n;
  private closed = false;
  readonly binding: Uint8Array;
  readonly remoteStatic: Uint8Array;
  constructor(send: Uint8Array, receive: Uint8Array, binding: Uint8Array, remote: Uint8Array) {
    this.tx = new Cipher(send);
    this.rx = new Cipher(receive);
    this.binding = binding.slice();
    this.remoteStatic = remote.slice();
  }
  seal(plaintext: Uint8Array) {
    if (this.closed) throw new LinkError("channel_closed");
    if (plaintext.length > MAX_PLAINTEXT) throw new LinkError("frame_too_large");
    try {
      const header = sequence(this.sent);
      const result = concat(header, this.tx.run(true, plaintext, header));
      this.sent++;
      return result;
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  open(frame: Uint8Array) {
    if (this.closed) throw new LinkError("channel_closed");
    try {
      if (frame.length < 24 || frame.length > MAX_FRAME) throw new LinkError("invalid_frame");
      const header = frame.subarray(0, 8);
      if (readSequence(header) !== this.received || !equal(header, sequence(this.received)))
        throw new LinkError("sequence_mismatch");
      const result = this.rx.run(false, frame.subarray(8), header);
      this.received++;
      return result;
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  dispose() {
    this.closed = true;
    this.tx.dispose();
    this.rx.dispose();
  }
}
