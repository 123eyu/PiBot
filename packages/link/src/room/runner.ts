import { sha256 } from "@noble/hashes/sha2.js";
import { concat, LinkError, MAX_FRAME, utf8 } from "../core/bytes.ts";

export const RUNNER_ROUTE_BYTES = 69;
export function runnerDeviceId(publicKey: Uint8Array) {
  if (publicKey.length !== 32) throw new LinkError("invalid_identity");
  return Array.from(sha256(publicKey), (b) => b.toString(16).padStart(2, "0")).join("");
}
export function runnerRoute(slot: string, frame: Uint8Array) {
  if (!/^[a-f0-9]{64}$/.test(slot) || frame.length > MAX_FRAME)
    throw new LinkError("invalid_frame");
  return concat(utf8(`pibr:${slot}`), frame);
}
export function readRunnerRoute(frame: Uint8Array) {
  if (frame.length <= RUNNER_ROUTE_BYTES || frame.length > MAX_FRAME + RUNNER_ROUTE_BYTES) return;
  if (
    frame[0] !== 112 ||
    frame[1] !== 105 ||
    frame[2] !== 98 ||
    frame[3] !== 114 ||
    frame[4] !== 58
  )
    return;
  const header = String.fromCharCode(...frame.subarray(0, RUNNER_ROUTE_BYTES));
  if (!/^pibr:[a-f0-9]{64}$/.test(header)) return;
  return { slot: header.slice(5), frame: frame.subarray(RUNNER_ROUTE_BYTES) };
}
