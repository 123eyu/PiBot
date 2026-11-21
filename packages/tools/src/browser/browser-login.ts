import {
  credentialSiteLabel,
  type LoginFieldReason,
  type LoginFillResult,
  RpcError,
} from "@pibot/protocol-base";
import type { PreparedToolView, ToolResult, ToolRuntime } from "../runtime/tool-runtime.ts";
import { BROWSER_TAKEOVER_STOP, browserDelay } from "./browser-execute.ts";

const TAKEOVER_WAIT_MS = 10 * 60 * 1000;
const TAKEOVER_POLL_MS = 2000;

export const LOGIN_CHOICE_REQUIRED =
  "同一网站有多个已保存账号；用 account 参数传一个显示名再调用，或用 ask_user 让用户选 / Several saved accounts are available; pass one display name as account, or ask the user with ask_user";

/**
 * What the page script recognised, in words. Codes are fixed, so this says why the box was
 * chosen without repeating anything the page itself wrote.
 */
const REASON_TEXT: Record<LoginFieldReason, { zh: string; en: string }> = {
  autocomplete: { zh: "autocomplete 标记", en: "autocomplete" },
  type: { zh: "输入框类型", en: "field type" },
  inputmode: { zh: "inputmode", en: "inputmode" },
  name: { zh: "名字或 ID", en: "name or id" },
  placeholder: { zh: "placeholder", en: "placeholder" },
  label: { zh: "标签文字", en: "label" },
  near_password: { zh: "紧挨密码框之前", en: "right before the password" },
  button: { zh: "登录 / 继续按钮", en: "sign-in button" },
  url: { zh: "登录页地址", en: "login page URL" },
  single_field: { zh: "页面上唯一的文本框", en: "the page's only text box" },
};

const reasonText = (code: LoginFieldReason) => REASON_TEXT[code] ?? { zh: code, en: code };

function fieldReason(reasons: LoginFieldReason[] | undefined): string {
  if (!reasons?.length) return "";
  const zh = reasons.map((code) => reasonText(code).zh).join("、");
  const en = reasons.map((code) => reasonText(code).en).join(", ");
  return `账号框：${zh} / Account field: ${en}`;
}

type LoginOk = Extract<LoginFillResult, { ok: true }>;

/**
 * The fill presses the account page's own "Continue" and waits for the password box, so the
 * result has to say which step it reached — the model must not go looking for a second call that
 * the tool already made, and must not tell the user it cannot type a password. Values never
 * appear here; only the display name, the box reasons and the step.
 */
function filledText(label: string, result: LoginOk): string {
  const why = fieldReason(result.reasons);
  const whyZh = why ? `（${why.split(" / ")[0]}）` : "";
  const whyEn = why ? ` (${why.split(" / ")[1]})` : "";
  const both = result.username && result.password;
  const fieldsZh = both ? "账号和密码" : result.password ? "密码" : "账号";
  const fieldsEn = both
    ? "the username and password"
    : result.password
      ? "the password"
      : "the username";
  const filled = `已用保存的账号「${label}」填写${fieldsZh}（值不可见）${whyZh} / Filled ${fieldsEn} with the saved account "${label}" (values stay hidden)${whyEn}`;
  // The step after the account page wants a code and there is no TOTP: the account is filled, so
  // this is a hand-over after progress, not a failure the model should retry.
  if (result.needsCode) {
    return `${filled}；账号已填并点了「继续」，下一步要验证码，请用户在浏览器里接管完成 / The account is filled and it pressed the page's own Continue; the next step needs a verification code, so ask the user to take over in the browser and finish it`;
  }
  if (!result.password) {
    return result.continueClicked
      ? `${filled}；已自己点了页面上的「继续」，但没有出现密码框（可能要验证码、选账号或人机验证）；请 browser_snapshot 看页面，需要时请用户接管 / It pressed the page's own Continue, but no password field appeared (a code, an account picker or a human check may be next); take a browser_snapshot and ask the user to take over if needed`
      : `${filled}；页面上没有找到可点的「继续」按钮，请 browser_snapshot 后自己点继续；密码框出现时再调用 browser_login 填密码 / No Continue/Next button was found to press; take a browser_snapshot and press it yourself, then call browser_login again on the password page to fill the password`;
  }
  const stepsZh = result.continueClicked
    ? "（先填账号，点了页面上的「继续」，密码框出现后填了密码）"
    : "";
  const stepsEn = result.continueClicked
    ? " (it filled the account, pressed the page's own Continue and filled the password once the field appeared)"
    : "";
  return `${filled}${stepsZh}；请 browser_snapshot 后点击登录按钮完成；若出现验证码或两步验证，请用户接管 / ${stepsEn}; take a browser_snapshot and click the sign-in button; ask the user to take over if a code or two-step check appears`;
}

const MAX_LISTED_ACCOUNTS = 10;

/**
 * Several saved accounts and none (or no existing one) named: the model has to pick one. The
 * refusal in the authorization step needs the same list, so it is exported as well.
 */
export function loginChoiceText(labels: string[]): string {
  const listed = labels.slice(0, MAX_LISTED_ACCOUNTS);
  const more = labels.length > listed.length ? "…" : "";
  return (
    `同一网站有多个已保存账号：${listed.join("、")}${more}。用 account 参数传其中一个显示名再调用一次，或用 ask_user 让用户选择 / ` +
    `Several saved accounts are available: ${listed.join(", ")}${more}. Call again with one of these display names as account, or ask the user with ask_user`
  );
}

const text = {
  notAllowed:
    "这个账号不能用于当前网页，请用户接管浏览器登录 / This saved account cannot be used on the current page; ask the user to take over and log in",
  origin:
    "当前网页和保存的网站不一致，已拒绝填写 / The current page does not belong to the saved website; nothing was filled",
  noFields:
    "当前网页上没找到账号框或密码框 / No username or password field was found on the current page",
  noPage:
    "浏览器没有打开网页，请先用 browser_open 打开登录页 / No page is open; open the login page with browser_open first",
  takeover: BROWSER_TAKEOVER_STOP,
  secrets:
    "系统钥匙串不可用，无法读取保存的密码 / Secure storage is unavailable, so the saved password cannot be read",
  failed: "自动登录失败 / Automatic login failed",
};

export async function executeBrowserLogin(
  runtime: ToolRuntime,
  prepared: PreparedToolView,
  signal: AbortSignal,
): Promise<ToolResult> {
  const browser = runtime.browser;
  if (!browser) return { text: text.failed, isError: true };
  const stopped = browser.retryBoundary("browser_login");
  if (stopped) return { text: stopped, isError: true };
  const selection = browser.loginSelection(prepared);
  const { login, chosen, label = "***" } = selection;
  if (!selection.available) return { text: text.failed, isError: true };
  if (!login || !selection.pageUrl) return { text: text.noPage, isError: true };
  if (!chosen || !login.accounts.some((account) => account.id === chosen))
    return { text: loginChoiceText(login.accounts.map((account) => account.label)), isError: true };
  const target = `login ${credentialSiteLabel(login.site)} (${label})`.slice(0, 500);
  const step = (result: "done" | "error" | "denied") =>
    browser.recordStep({
      toolCallId: prepared.call.id,
      target,
      action: {
        kind: "login",
        subject: `${credentialSiteLabel(login.site)} (${label})`.slice(0, 300),
      },
      result,
    });
  const audit = (reason: string) =>
    browser.auditLogin(chosen, login.site, label, prepared.call.id, reason.slice(0, 80));

  await browser.configure(prepared, runtime.writeRoots(prepared)[0], signal);
  const deadline = Date.now() + TAKEOVER_WAIT_MS;
  let result: Awaited<ReturnType<typeof browser.fillLogin>>;
  try {
    for (;;) {
      try {
        result = await browser.fillLogin(prepared, chosen, signal);
        break;
      } catch (error) {
        if (!(error instanceof RpcError)) throw error;
        if (error.message !== "browser_takeover" || browser.isYolo() || Date.now() > deadline)
          throw error;
        browser.pauseTakeover();
        try {
          await browserDelay(TAKEOVER_POLL_MS, signal);
        } finally {
          browser.resumeTakeover();
        }
      }
    }
  } catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof RpcError)) throw error;
    if (error.message === "browser_takeover") browser.stopRetries("takeover");
    audit(error.message);
    await step("error");
    return {
      text:
        error.message === "browser_takeover"
          ? text.takeover
          : error.message === "browser_pages_closed_open_again"
            ? text.noPage
            : error.message === "secrets_unavailable"
              ? text.secrets
              : error.message === "credential_not_allowed" ||
                  error.message === "credential_site_mismatch"
                ? text.notAllowed
                : text.failed,
      isError: true,
    };
  }
  if (!result.ok) {
    audit(result.code);
    await step(result.code === "origin_mismatch" ? "denied" : "error");
    return {
      text:
        result.code === "origin_mismatch"
          ? text.origin
          : result.code === "totp_unavailable"
            ? "当前账号没有可用的两步验证码，请用户接管完成验证 / No two-step code is available for this account; ask the user to take over"
            : result.code === "no_fields"
              ? text.noFields
              : text.noPage,
      isError: true,
    };
  }
  audit("filled");
  await step("done");
  browser.completeLogin(login.site, chosen, result.page);
  if (result.totp) return { text: "已填写验证码 / Verification code filled" };
  return { text: filledText(label, result) };
}
