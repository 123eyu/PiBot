import type { PhoneControlGrant, Port } from "@pibot/protocol-base";
import { z } from "zod";
import type { RandomBytes } from "../core/bytes.ts";
import type { EndpointKeys } from "../keys/endpoint.ts";
import { admitRunnerPort } from "../transport/runner-direct.ts";
import { connectRunnerPunch, isRunnerPunchMessage } from "../transport/runner-punch.ts";
import type { RtcPeerFactory } from "../transport/upgrade.ts";

const selection = z.strictObject({
  jsonrpc: z.literal("2.0"),
  method: z.literal("link.phoneRunner.path"),
  params: z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("relay") }),
    z.strictObject({ mode: z.literal("punch"), id: z.string().regex(/^[a-f0-9]{32}$/) }),
  ]),
});
type Choice = z.infer<typeof selection>["params"];

/** Negotiate before releasing any business frame; the relay remains the authenticated standby. */
export async function phoneRunnerPath(options: {
  port: Port;
  signal: AbortSignal;
  keys: EndpointKeys;
  grant: PhoneControlGrant;
  role: "initiator" | "responder";
  random: RandomBytes;
  createPeer?: RtcPeerFactory;
}) {
  const { port, role } = options;
  let relay: ReturnType<typeof admitRunnerPort> | undefined;
  const prepareRelay = () => {
    relay ??= admitRunnerPort(
      {
        ...port,
        onMessage: (fn) =>
          port.onMessage((value) => {
            if (selection.safeParse(value).success || isRunnerPunchMessage(value)) return;
            fn(value);
          }),
      },
      options.signal,
      async () => {
        port.dispose?.();
      },
      role,
    );
    return relay;
  };
  let received: Choice | undefined;
  let changed = () => {};
  const off = port.onMessage((value) => {
    const parsed = selection.safeParse(value);
    if (parsed.success) {
      received = parsed.data.params;
      if (received.mode === "relay") prepareRelay();
      changed();
    }
  });
  const choose = (choice: Choice) => {
    if (choice.mode === "relay") prepareRelay();
    port.post({ jsonrpc: "2.0", method: "link.phoneRunner.path", params: choice });
  };
  const wait = async () => {
    if (received) {
      const value = received;
      received = undefined;
      return value;
    }
    return new Promise<Choice>((resolve, reject) => {
      const finish = () => {
        if (!received && !signal.aborted) return;
        signal.removeEventListener("abort", finish);
        changed = () => {};
        if (signal.aborted) reject(new Error("phone_path_timeout"));
        else {
          const value = received as Choice;
          received = undefined;
          resolve(value);
        }
      };
      const signal = AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]);
      changed = finish;
      signal.addEventListener("abort", finish, { once: true });
      finish();
    });
  };
  try {
    let choice: Choice;
    if (role === "responder") {
      choice =
        options.grant.body.stunUrl && options.createPeer
          ? {
              mode: "punch",
              id: Array.from(options.random(16), (b) => b.toString(16).padStart(2, "0")).join(""),
            }
          : { mode: "relay" };
      choose(choice);
    } else choice = await wait();
    if (choice.mode === "punch") {
      let candidate: Awaited<ReturnType<typeof connectRunnerPunch>> | undefined;
      const attempt = new AbortController();
      const timer = setTimeout(() => attempt.abort(), 5000);
      try {
        if (!options.createPeer || !options.grant.body.stunUrl)
          throw new Error("phone_punch_unsupported");
        candidate = await connectRunnerPunch({
          port,
          id: choice.id,
          stunUrl: options.grant.body.stunUrl,
          keys: options.keys,
          publicKey: role === "initiator" ? options.grant.body.phone : options.grant.body.runner,
          role,
          random: options.random,
          createPeer: options.createPeer,
          signal: AbortSignal.any([options.signal, attempt.signal]),
        });
        if (role === "responder") candidate.select();
        else await candidate.selected();
        await candidate.activate();
        return { ...candidate, path: "punched" as const };
      } catch {
        await candidate?.close();
        if (options.signal.aborted) throw new Error("phone_path_closed");
        if (role === "responder") choose({ mode: "relay" });
        else {
          port.post({
            jsonrpc: "2.0",
            method: "link.runner.punch.unsupported",
            params: { id: choice.id },
          });
          if ((await wait()).mode !== "relay") throw new Error("phone_path_invalid");
        }
      } finally {
        clearTimeout(timer);
      }
    }
    const relay = prepareRelay();
    if (role === "responder") relay.select();
    else await relay.selected();
    await relay.activate();
    return { ...relay, path: "relay" as const };
  } finally {
    off();
  }
}
