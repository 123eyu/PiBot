import type { TranslationKey } from "@pibot/i18n";
import type { Peer } from "../../rpc/context.ts";
export class SetupError extends Error {
  constructor(readonly key: TranslationKey) {
    super(key);
  }
}

export function requirePeer(peer: Peer | null): Peer {
  if (!peer) throw new SetupError("setup.disconnected");
  return peer;
}
