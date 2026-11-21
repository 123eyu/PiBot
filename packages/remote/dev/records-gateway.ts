// Development harness for the records probe (apps/mobile `probe --records`): the real phone
// gateway (allowlist, parameter checks, 3-day window, page caps, frame limit) on an in-memory
// wire, in front of a scripted kernel. No brain, relay, encryption or network is involved.
import { randomUUID } from "node:crypto";
import { createPeer, Events, Methods, type Port } from "@pibot/protocol";
import type { PhoneBrowser } from "../src/brain/browser/phone-browser.ts";
import { PhoneEventBuffer } from "../src/brain/rpc/event-buffer.ts";
import { phoneGateway } from "../src/brain/rpc/gateway.ts";
import type { RemoteReceiptsRepo } from "../src/store/index.ts";
import { memoryPorts } from "./transport/memory.ts";

export type RecordsDispatch = (method: string, params: unknown) => Promise<unknown>;
export function startRecordsGateway(dispatch: RecordsDispatch) {
  const wire = memoryPorts();
  const abort = new AbortController();
  const audits: { method: string; outcome: string }[] = [];
  /** UTF-8 sizes of every frame the gateway sent the phone. */
  const frames: number[] = [];
  /** What the kernel was asked, after the gateway's clamps. */
  const dispatched: { method: string; params: unknown }[] = [];
  const port: Port = {
    ...wire.a,
    post(message) {
      frames.push(Buffer.byteLength(JSON.stringify(message)));
      wire.a.post(message);
    },
  };
  const gateway = phoneGateway({
    deviceId: randomUUID(),
    port,
    kernel: {
      dispatch: (method, params) => {
        dispatched.push({ method, params });
        return dispatch(method, params);
      },
      subscribe: () => () => {},
    },
    buffer: new PhoneEventBuffer(),
    // Only chat.send and the browser methods use these; the records probe calls neither.
    receipts: {} as RemoteReceiptsRepo,
    browser: { close: async () => {} } as unknown as PhoneBrowser,
    signal: abort.signal,
    active() {},
    self: () => ({}),
    update: async () => ({}),
    audit: (method, outcome) => audits.push({ method, outcome }),
  });
  const phone = createPeer(wire.b, { methods: Methods, events: Events });
  return {
    phone,
    audits,
    frames,
    dispatched,
    async stop() {
      phone.dispose();
      await gateway.close();
      abort.abort();
    },
  };
}
