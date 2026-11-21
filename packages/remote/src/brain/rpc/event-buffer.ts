import { randomBytes } from "node:crypto";
import { type BufferedEvent, EventBuffer, Events, RpcError, RpcErrorCodes } from "@pibot/protocol";
/** The kernel buffer limits count only; a remote device must also have a byte budget. */
export class PhoneEventBuffer extends EventBuffer<typeof Events> {
  /**
   * Names this sequence space for the phone (`devices.self.eventStream`). A new buffer (brain
   * restart, remote turned off, unpair) restarts at 1, so a cursor from another one must not be
   * resumed against it even when the numbers happen to fit.
   */
  readonly id = randomBytes(18).toString("base64url");
  private current = 0;
  private total = 0;
  private entries: { event: BufferedEvent; bytes: number }[] = [];
  constructor() {
    super(Events, 1);
  }
  /** The last sequence handed out (live or buffered). */
  get seq() {
    return this.current;
  }
  override append(method: string, payload: unknown): BufferedEvent {
    if (!Object.hasOwn(Events, method))
      throw new RpcError(RpcErrorCodes.invalidParams, "remote_event_invalid");
    const parsed = Events[method as keyof typeof Events].safeParse(payload);
    if (!parsed.success) throw new RpcError(RpcErrorCodes.invalidParams, "remote_event_invalid");
    const bytes = Buffer.byteLength(JSON.stringify(parsed.data));
    if (bytes > 900_000 || this.current >= Number.MAX_SAFE_INTEGER)
      throw new RpcError(RpcErrorCodes.resumeUnavailable, "remote_event_unavailable");
    const event = {
      jsonrpc: "2.0" as const,
      method,
      params: { seq: ++this.current, payload: structuredClone(parsed.data) },
    };
    // Activity is viewport state: sequence it for the live peer, but never replay it after a gap.
    if (method === "chat.activity") return structuredClone(event);
    this.entries.push({ event, bytes });
    this.total += bytes;
    while (this.entries.length > 200 || this.total > 2 * 1024 * 1024)
      this.total -= this.entries.shift()?.bytes ?? 0;
    return structuredClone(event);
  }
  override resume(afterSeq: number): BufferedEvent[] {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0)
      throw new RpcError(RpcErrorCodes.invalidParams, "remote_cursor_invalid");
    const first = this.entries[0]?.event.params.seq ?? this.current + 1;
    if (afterSeq > this.current || afterSeq < first - 1)
      throw new RpcError(RpcErrorCodes.resumeUnavailable, "remote_history_unavailable");
    return structuredClone(
      this.entries.filter(({ event }) => event.params.seq > afterSeq).map(({ event }) => event),
    );
  }
}
