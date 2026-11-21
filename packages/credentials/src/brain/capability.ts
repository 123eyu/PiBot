import type { BrainCapability } from "@pibot/brain/kit";
import { registerCredentialRpc } from "./accounts/credentials-rpc.ts";
import { CredentialService } from "./accounts/credentials-service.ts";
import { GoogleCompatService } from "./accounts/google-compat.ts";
import type { CredentialContext } from "./context.ts";
import { credentialInitialization } from "./initialization.ts";
import { registerUserSecretRpc, UserSecretService } from "./secrets/user-secret-service.ts";

export function credentialsCapability(): BrainCapability {
  return {
    id: "credentials",
    register(ctx) {
      const local = ctx.local;
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, local.shutdown.signal]);
      const context: CredentialContext = {
        deps: {
          db: ctx.db,
          host: ctx.host,
          redactor: ctx.redactor,
          logger: ctx.logger,
          peer: ctx.peer,
          platform: local.deps.platform,
        },
        shutdown: { signal },
        approvals: {
          audit: local.approvals.audit,
          pauseExpiredChat: (id) => local.approvals.pauseExpiredChat(id),
          repo: local.approvals.repo,
          resolve: (...args) => local.approvals.resolve(...args),
        },
        browser: {
          refreshGoogleCompat: (...args) =>
            local.browserProvider?.refreshGoogleCompat(...args) ?? Promise.resolve(),
          refreshGroupGoogleCompat: (...args) =>
            local.browserProvider?.refreshGroupGoogleCompat(...args) ?? Promise.resolve(),
        },
      };
      const credentials = new CredentialService(context);
      const userSecrets = new UserSecretService(context);
      const googleCompat = new GoogleCompatService(context);
      const initialization = credentialInitialization(userSecrets, credentials, signal);
      ctx.sleep.participate({ idle: initialization.idle });
      ctx.credentialServices.provide({
        credentials,
        userSecrets,
        googleCompat,
        ready: initialization.ready,
      });
      registerCredentialRpc(ctx.rpc.handle, credentials, local.shutdown.signal);
      registerUserSecretRpc(ctx.rpc.handle, userSecrets);
      ctx.rpc.handle("browser.googleCompat.get", async (scope) => googleCompat.get(scope));
      ctx.rpc.handle("browser.googleCompat.set", ({ enabled, ...scope }) =>
        googleCompat.set(scope, enabled),
      );
      // Content consumers join this owner; readiness itself never waits for a keyring prompt.
      void initialization.ready(signal).catch(() => {
        if (!signal.aborted)
          ctx.logger.warn(
            "Secret redaction initialization unavailable; content gates remain locked",
          );
      });
      // Runtime owns these choices through its final drain; LocalService.dispose releases them.
      return {
        async stop() {
          controller.abort();
          await initialization.settled();
        },
      };
    },
  };
}
