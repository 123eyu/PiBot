import type { Methods } from "@pibot/protocol";
export interface RemoteKernelEvent {
  method: string;
  payload: unknown;
}
/** Must dispatch through the existing kernel wrapper, never direct ChatService/approval calls. */
export interface RemoteKernelPort {
  dispatch(
    method: keyof typeof Methods,
    params: unknown,
    context: { deviceId: string; signal: AbortSignal },
  ): Promise<unknown>;
  /** The kernel owns schema validation and outbound redaction before publishing these events. */
  subscribe(listener: (event: RemoteKernelEvent) => void): () => void;
}
export interface RemoteHostPort {
  /** A distinct renewable lease, composed with routines' lease rather than replacing it. */
  keepAwake(enabled: boolean, signal: AbortSignal): Promise<"off" | "requested" | "unsupported">;
}
