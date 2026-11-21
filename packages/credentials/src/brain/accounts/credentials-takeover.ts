import { setImmediate } from "node:timers/promises";
import {
  type Credential,
  credentialSiteLabel,
  credentialSiteMatches,
  type MethodParams,
  type MethodResults,
  RpcError,
  RpcErrorCodes,
} from "@pibot/credentials-contract/full";
import type { CredentialContext } from "../context.ts";
import type { CredentialService } from "./credentials-service.ts";

export async function takeoverAccounts(
  local: CredentialContext,
  credentials: CredentialService,
  params: MethodParams["credentials.takeoverAccounts"],
  signal: AbortSignal,
): Promise<MethodResults["credentials.takeoverAccounts"]> {
  const host = local.deps.host.credentials;
  if (!host) return null;
  const current = await host.call("host.browser.login.takeoverPage", params, signal);
  if (!current) return null;
  const accounts: Credential[] = [];
  let after: string | undefined;
  // Filter every page, rather than losing a site's accounts behind unrelated earlier sites.
  while (accounts.length < 200) {
    signal.throwIfAborted();
    const page = credentials.repo.list({
      botId: params.botId,
      ...(after ? { after } : {}),
      limit: 200,
    });
    for (const entry of page)
      if (accounts.length < 200 && credentialSiteMatches(entry.site, current.page.url))
        accounts.push({ ...entry, note: "" });
    if (page.length < 200) break;
    after = page.at(-1)?.id;
    await setImmediate(undefined, { signal });
  }
  return { ...current, accounts };
}

/** A direct user action fills once; it never creates grants or widens the Bot's run rules. */
export async function fillForTakeover(
  local: CredentialContext,
  credentials: CredentialService,
  params: MethodParams["credentials.fillForTakeover"],
  signal: AbortSignal,
): Promise<MethodResults["credentials.fillForTakeover"]> {
  const host = local.deps.host.credentials;
  if (!host) throw new RpcError(RpcErrorCodes.unsupported, "browser_unavailable");
  const current = await host.call(
    "host.browser.login.takeoverPage",
    { botId: params.botId, ...(params.groupId ? { groupId: params.groupId } : {}) },
    signal,
  );
  if (!current) return { ok: false, code: "no_page" };
  if (current.page.tab !== params.tab || current.documentId !== params.documentId)
    return { ok: false, code: "page_changed" };
  const secret = await credentials.secretFor(
    params.botId,
    params.credentialId,
    current.page.url,
    signal,
  );
  secret.assertCurrent();
  const result = await host.call(
    "host.browser.fillLogin",
    {
      botId: params.botId,
      ...(params.groupId ? { groupId: params.groupId } : {}),
      site: secret.record.site,
      username: secret.username,
      password: secret.password,
      ...(secret.totp ? { totp: secret.totp, totpExpiresAt: secret.totpExpiresAt } : {}),
      takeover: { tab: params.tab, documentId: params.documentId },
    },
    signal,
  );
  local.approvals.audit.append({
    botId: params.botId,
    kind: "credential.filled",
    summary: "Saved account filled during user takeover",
    detail: {
      actor: "user",
      credentialId: params.credentialId,
      domain: credentialSiteLabel(secret.record.site),
      reasonCode: result.ok ? "filled" : result.code,
    },
  });
  return result;
}
