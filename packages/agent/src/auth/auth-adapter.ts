import type { ApiKeyAuth, CredentialStore } from "@earendil-works/pi-ai";
import { isChatGPTPlanProvider } from "@pibot/protocol-base/provider-catalog";
import { AgentError } from "../core/errors.ts";
import type { AgentAuthPorts, CloudMaterial } from "../core/types.ts";
import { chatGPTSubscriptionAccess } from "./chatgpt-access.ts";
import { assertSupportedCredential } from "./claude-subscription.ts";

// Only the ChatGPT plan provider stores model OAuth credentials, and only in a release whose gate
// is open. Every other provider id, OpenAI's API-key one included, reads as signed out
// and cannot be written.
function chatGPTStored(id: string): boolean {
  return isChatGPTPlanProvider(id) && chatGPTSubscriptionAccess.available;
}

export function oauthStore(ports: AgentAuthPorts): CredentialStore {
  return {
    async read(id, options) {
      options?.signal?.throwIfAborted();
      if (!chatGPTStored(id)) return undefined;
      const value = await ports.read(id);
      assertSupportedCredential(value?.access);
      assertSupportedCredential(value?.refresh);
      return value;
    },
    async list(options) {
      options?.signal?.throwIfAborted();
      return ports.entries().filter((entry) => chatGPTStored(entry.providerId));
    },
    async modify(id, update, options) {
      if (isChatGPTPlanProvider(id) && !chatGPTSubscriptionAccess.available)
        throw new AgentError("openai_approval_required");
      if (!chatGPTStored(id)) throw new AgentError("subscription_unsupported");
      let updated = false;
      const result = await ports.modify(
        id,
        async (value) => {
          assertSupportedCredential(value?.access);
          assertSupportedCredential(value?.refresh);
          const next = await update(value);
          if (next && next.type !== "oauth")
            throw new TypeError("OAuth namespace requires OAuth credentials");
          assertSupportedCredential(next?.access);
          assertSupportedCredential(next?.refresh);
          updated = next !== undefined;
          return next;
        },
        options?.signal,
      );
      // A successful HTTP refresh alone is insufficient: rotation must survive
      // a keyring/write failure before the UI can say authentication recovered.
      if (updated && result) ports.authenticated?.(id);
      return result;
    },
    async delete(id, options) {
      if (!chatGPTStored(id)) throw new AgentError("subscription_unsupported");
      await ports.remove(id, options?.signal);
    },
  };
}

export function cloudAuth(ports: AgentAuthPorts, id: string): ApiKeyAuth {
  return {
    name: "Pi Bot cloud credential",
    async check({ signal }) {
      signal.throwIfAborted();
      return ports.mode(id) === "cloud" && ports.has(id)
        ? { type: "api_key", source: "Pi Bot" }
        : undefined;
    },
    async resolve({ signal }) {
      const material = await ports.cloud(id, signal);
      if (!material) return undefined;
      return cloudAuthResult(material);
    },
  };
}
export function cloudAuthResult(material: CloudMaterial) {
  assertSupportedCredential(material.apiKey);
  return {
    auth:
      material.providerId === "cloudflare-ai-gateway"
        ? {
            apiKey: "pibot-gateway",
            headers: {
              "cf-aig-authorization": `Bearer ${material.apiKey}`,
              authorization: null,
              "x-api-key": null,
            },
          }
        : material.apiKey
          ? { apiKey: material.apiKey }
          : {},
    env: material.env,
    source: "Pi Bot",
  };
}
