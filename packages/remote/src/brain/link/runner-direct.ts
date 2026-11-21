import { randomBytes } from "node:crypto";
import {
  base64url,
  connectRunnerSocket,
  createRunnerDrain,
  destroyEndpoint,
  endpointKeys,
  resumeRunnerDrain,
  type SocketLike,
  unbase64,
} from "@pibot/link";
import { lanToken } from "@pibot/link/lan";
import { parseRunnerAddress } from "@pibot/link/runner-address";
import { WebSocket } from "ws";
import { z } from "zod";
import type { EndpointIdentity, LinkSession } from "./port.ts";

export async function acceptRunnerDirect(
  socket: SocketLike,
  input: {
    identity: EndpointIdentity;
    publicKey: string;
    signal: AbortSignal;
  },
  path: "lan" | "address",
): Promise<LinkSession> {
  const seed = unbase64(input.identity.privateKey, 32);
  const keys = endpointKeys(seed);
  seed.fill(0);
  try {
    if (base64url(keys.signingPublic) !== input.identity.publicKey)
      throw new Error("remote_identity_mismatch");
    const session = await connectRunnerSocket(socket, {
      keys,
      publicKey: input.publicKey,
      role: "responder",
      signal: input.signal,
      random: randomBytes,
    });
    return {
      ...session,
      runnerPath: path,
      onPresence(listener) {
        listener(!session.signal.aborted);
        const closed = () => listener(false);
        session.signal.addEventListener("abort", closed, { once: true });
        return () => session.signal.removeEventListener("abort", closed);
      },
    };
  } finally {
    destroyEndpoint(keys);
  }
}

export async function dialRunnerAddress(
  address: string,
  input: Parameters<typeof acceptRunnerDirect>[1] & { roomSecret: string },
) {
  // Authenticated metadata is still only a route hint, never an identity or a URL capability.
  const url = new URL(`ws://${parseRunnerAddress(address).address}`);
  const key = unbase64(z.object({ key: z.string() }).parse(JSON.parse(input.roomSecret)).key, 32);
  try {
    url.pathname = `/link/${lanToken(key, "00000000000000000000000000000000")}`;
  } finally {
    key.fill(0);
  }
  const socket = new WebSocket(url, {
    handshakeTimeout: 5000,
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
  });
  // A close receipt outlives failed opens, including failures before the first await.
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  const ignoreError = () => {
    /* close owns failures; raw network errors are not diagnostic text. */
  };
  socket.on("error", ignoreError);
  socket.once("close", () => socket.off("error", ignoreError));
  const abort = () => socket.terminate();
  input.signal.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        socket.off("open", open);
        socket.off("error", error);
        socket.off("close", error);
        input.signal.removeEventListener("abort", cancelled);
      };
      const open = () => {
        done();
        resolve();
      };
      const error = () => {
        done();
        reject(new Error("runner_address_unavailable"));
      };
      const cancelled = () => error();
      socket.once("open", open);
      socket.once("error", error);
      socket.once("close", error);
      input.signal.addEventListener("abort", cancelled, { once: true });
      if (input.signal.aborted) error();
    });
    return await acceptRunnerDirect(socket as unknown as SocketLike, input, "address");
  } catch (error) {
    socket.terminate();
    await createRunnerDrain(
      [() => resumeRunnerDrain(error), () => closed],
      input.signal,
      () => {},
    )();
    throw error;
  } finally {
    input.signal.removeEventListener("abort", abort);
  }
}
