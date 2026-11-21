import { type ChatPeer, updateChatBots } from "@pibot/client-core";
import type { MethodParams } from "@pibot/protocol";

export {
  choosePiModel,
  configureOllama,
  providerIdentity,
  registerOllama,
  saveKey,
  testProvider,
  validateCustom,
  writeCredential,
} from "@pibot/models/ui";
export { requirePeer, SetupError } from "@pibot/renderer-kit";
export async function updateBot(peer: ChatPeer, params: MethodParams["bots.update"]) {
  const bot = await peer.call("bots.update", params);
  // All cached topics for this Bot share the confirmed result; unrelated Bots keep their own state.
  updateChatBots(peer, bot);
  return bot;
}
