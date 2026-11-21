import type { TranslationKey } from "@pibot/i18n";
import { RpcError } from "@pibot/plugins-contract/full";
import { knowledgeZh } from "@pibot/plugins-contract/i18n";
import { connectorError } from "../../shell/remote.ts";

/** Wire codes carry their namespace (`knowledge_vault_changed`); the copy table keeps the tail. */
const PREFIX = "knowledge_";

/**
 * Knowledge RPCs report their own codes (`knowledge_vault_changed`), which the connection
 * mapper would flatten into 「失败了」. Only codes that have copy are translated; everything else
 * falls back to the connection wording this page already uses.
 */
export function knowledgeError(error: unknown): TranslationKey {
  if (error instanceof RpcError && error.message.startsWith(PREFIX)) {
    // The namespace is on the wire but not in the keys, so strip it before the lookup; keeping one
    // marker (`knowledge_`) in both places is what keeps the two tables from drifting apart.
    const key = `knowledge.error.${error.message.slice(PREFIX.length)}`;
    if (Object.hasOwn(knowledgeZh, key)) return key as TranslationKey;
  }
  return connectorError(error);
}
