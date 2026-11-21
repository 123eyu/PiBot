import type { RegisterRpc } from "@pibot/brain/kit";
import { RpcError } from "@pibot/models-contract/full";
import type { ProviderAuth } from "./provider-auth.ts";

export function registerProviderAuthRpc(handle: RegisterRpc, auth: ProviderAuth) {
  handle("providers.getConfig", async ({ providerId }) => auth.config(providerId));
  handle("providers.setCredentials", async (input) => {
    await auth.providers.serialize(() => auth.setCloud(input));
    return { ok: true };
  });
  handle("providers.authState", async ({ providerId }) => auth.getState(providerId));
  handle("providers.selectAuth", async ({ providerId, auth: mode }) => {
    await auth.providers.serialize(async () => auth.select(providerId, mode));
    return { ok: true };
  });
  handle("providers.login", async ({ providerId }) => {
    // Unsupported ids and a closed release fail before the keyring or any SDK work is touched.
    auth.assertLoginSupported(providerId);
    if (!(await auth.vault.available())) throw new RpcError(-32012, "secrets_unavailable");
    return auth.login(providerId);
  });
  handle("providers.cancelLogin", async ({ providerId }) => {
    auth.cancel(providerId);
    return { ok: true };
  });
  handle("providers.logout", async ({ providerId }) => {
    await auth.logout(providerId);
    return { ok: true };
  });
  handle("providers.loginStep", async ({ providerId }) => auth.flows.get(providerId)?.step ?? null);
  handle("providers.loginInput", async ({ providerId, promptId, value }) => {
    const flow = auth.flows.get(providerId);
    if (!flow) throw new RpcError(-32602, "login_unavailable");
    flow.input(promptId, value);
    return { ok: true };
  });
}
