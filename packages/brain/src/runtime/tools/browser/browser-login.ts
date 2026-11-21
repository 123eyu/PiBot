import { credentialSiteLabel, type LoginApprovalRequest } from "@pibot/protocol-base";
import { z } from "zod";
import type { PreparedTool } from "../../../core/local-types.ts";

// The model can name the current site, but never an account or any saved secret. A saved
// display name is not a secret — it is what the user sees on the card — so the model may pass it
// when several accounts exist for one site.
export const browserLoginSchema = z.strictObject({
  site: z.string().min(1).max(2048).optional(),
  account: z.string().trim().min(1).max(200).optional(),
});
export const browserLoginDescription =
  "Log in on the current page of your browser with an account the user saved in Pi Bot for this website (optionally name the site). It fills the username and the password itself, including two-step logins: on an account page it presses the page's own Next/Continue (never the final sign-in button) and fills the password once the field appears. You never see the values, only which fields were filled and the account's display name. The first time on a site the user is asked. If several accounts are saved for the site, pass one display name from the result as account. When it filled the password, take a browser_snapshot and click the sign-in button; the result says when the password step was not reached. Never tell the user you cannot type their saved password and never ask them to type it: ask the user to take over only for a verification code, a human check, a card, or when no account is saved (or the user declines). / 用用户在 Pi Bot 里为这个网站保存的账号登录当前页面（可用 site 指明网站）。账号和密码都由它自己填，包括两步登录：在账号页会自己点页面上的「继续 / 下一步」（不会点最终的登录按钮），密码框出现后填密码。你看不到填入的值，只知道填了哪些框和账号显示名。第一次在一个网站登录会问用户。同一网站有多个已保存账号时，从返回结果里挑一个显示名作为 account 传进来。填好密码后请 browser_snapshot 并点击登录按钮；结果会说没到密码步。不要告诉用户你不能替他输入已保存的密码，也不要让用户自己输入；只有验证码、人机验证、银行卡或没有保存账号（或用户拒绝）时才请用户接管。";

/**
 * The saved account whose display name the model named. Matching ignores case and outer
 * whitespace; two accounts with the same label stay ambiguous (no pick at all) so neither one is
 * guessed.
 */
export function accountChoice(
  login: LoginApprovalRequest,
  account: string | undefined,
): LoginApprovalRequest["accounts"][number] | undefined {
  const wanted = account?.trim().toLowerCase();
  if (!wanted) return undefined;
  const matches = login.accounts.filter(
    (candidate) => candidate.label.trim().toLowerCase() === wanted,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Whether this call still needs the user to pick an account (the `browser_login_choose` gate).
 * Naming one saved display name settles it — before this, YOLO had no way to pick and every
 * multi-account site was refused with "turn YOLO off".
 */
export function loginNeedsChoice(prepared: Pick<PreparedTool, "login" | "call">): boolean {
  const login = prepared.login;
  if (!login || login.accounts.length <= 1) return false;
  const account = prepared.call.input.account;
  return !accountChoice(login, typeof account === "string" ? account : undefined);
}

/** Card title: "<Bot> 要用 <账号> 登录 <网站>". */
export function loginTitle(
  botName: string,
  login: LoginApprovalRequest,
  language: "zh" | "en",
): string {
  const site = credentialSiteLabel(login.site);
  const only = login.accounts.length === 1 ? login.accounts[0]?.label : undefined;
  if (language === "zh")
    return only ? `${botName} 要用 ${only} 登录 ${site}` : `${botName} 要登录 ${site}，请选择账号`;
  return only
    ? `${botName} wants to log in to ${site} as ${only}`
    : `${botName} wants to log in to ${site}; choose an account`;
}
