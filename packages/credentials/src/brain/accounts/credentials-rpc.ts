import type { RegisterRpc } from "@pibot/brain/kit";
import type { CredentialService } from "./credentials-service.ts";

/** Saved accounts, registered through brain's single RPC wrapper (validation, errors). */
export function registerCredentialRpc(
  handle: RegisterRpc,
  credentials: CredentialService,
  shutdown: AbortSignal,
) {
  // Touch ID / password prompts wait for the user; bounded so a forgotten prompt cannot pin it.
  const prompt = () => AbortSignal.any([shutdown, AbortSignal.timeout(180_000)]);
  const hostCall = () => AbortSignal.any([shutdown, AbortSignal.timeout(30_000)]);
  handle("credentials.status", () => credentials.status());
  handle("credentials.takeoverAccounts", (params) =>
    credentials.takeoverAccounts(params, hostCall()),
  );
  handle("credentials.fillForTakeover", (params) =>
    credentials.fillForTakeover(params, hostCall()),
  );
  handle("credentials.list", async (params) => credentials.list(params));
  handle("credentials.save", (params) => credentials.save(params));
  handle("credentials.delete", async ({ id }) => credentials.delete(id));
  handle("credentials.reveal", ({ id }) => credentials.reveal(id, prompt()));
  handle("credentials.capture.get", async ({ botId }) => credentials.capture(botId));
  handle("credentials.capture.resolve", (params) => credentials.resolveCapture(params, hostCall()));
  handle("credentials.login.resolve", (params) => credentials.resolveLogin(params));
}
