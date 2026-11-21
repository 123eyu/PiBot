import { z } from "zod";
import type { RemoteResources } from "../runtime/context.ts";
import type { RemoteLinkPort } from "./port.ts";

const IdentitySchema = z.strictObject({
  publicKey: z.string().min(16).max(4096),
  privateKey: z.string().min(16).max(8192),
});
export async function remoteIdentity(
  resources: RemoteResources,
  link: RemoteLinkPort,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const saved = await resources.secrets.get("remote-identity", "keypair");
  const identity = saved
    ? IdentitySchema.parse(JSON.parse(saved))
    : IdentitySchema.parse(await link.createIdentity(signal));
  resources.ctx.redactor.add(identity.privateKey);
  signal.throwIfAborted();
  if (!saved) await resources.secrets.set("remote-identity", "keypair", JSON.stringify(identity));
  signal.throwIfAborted();
  return identity;
}
export const roomScope = (id: string) => `remote-device:${id}`;
export const pushScope = (id: string) => `remote-push:${id}`;
