import {
  destroyEndpoint,
  endpointKeys,
  openPhoneRunnerSession,
  type SocketConstructor,
  unbase64,
} from "@pibot/link";
import type { MobileStorage } from "../storage/state.ts";
import { readCredential } from "../transport/credential.ts";
import { discoverLan } from "../transport/lan-discovery.ts";
import { createMobileRtcPeer } from "../transport/real-link.ts";
import { readRunnerAuthorizations } from "./runner-authorizations.ts";
import type { KeyVault } from "./vault.ts";

export function runnerConnection(storage: MobileStorage, vault: KeyVault) {
  return async (computerId: string, target: string, signal: AbortSignal) => {
    const computer = (await storage.computers()).find((c) => c.id === computerId);
    const raw = await storage.secrets.get(computerId);
    if (!computer || !raw) throw new Error("runner_authorization_unavailable");
    const credential = readCredential(raw);
    if (credential.publicKey !== computer.publicKey)
      throw new Error("runner_authorization_changed");
    const grant = (await readRunnerAuthorizations(vault, computerId, computer.publicKey)).find(
      (g) => `runner:${g.body.runnerId}` === target,
    );
    if (!grant) throw new Error("runner_authorization_unavailable");
    const seed = unbase64(credential.seed, 32);
    const keys = endpointKeys(seed);
    seed.fill(0);
    try {
      const wire = await openPhoneRunnerSession({
        keys,
        grant,
        issuer: computer.publicKey,
        relay: credential.relay,
        WebSocket: WebSocket as unknown as SocketConstructor,
        random: (size) => crypto.getRandomValues(new Uint8Array(size)),
        signal,
        discover: discoverLan,
        createPeer: createMobileRtcPeer,
      });
      return {
        capabilities: grant.body.capabilities,
        wire: {
          ...wire,
          async close() {
            try {
              await wire.close();
            } finally {
              destroyEndpoint(keys);
            }
          },
        },
      };
    } catch (error) {
      destroyEndpoint(keys);
      throw error;
    }
  };
}
