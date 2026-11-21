import { createTranslator } from "@pibot/i18n";

export type NoticeKind = "private" | "not_listed" | "failed";

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

const keys = {
  private: ["botBrowser.page.privateTitle", "botBrowser.page.privateBody"],
  not_listed: ["botBrowser.page.notListedTitle", "botBrowser.page.notListedBody"],
  failed: ["botBrowser.page.failedTitle", "botBrowser.page.failedBody"],
} as const;

/**
 * The page the Bot browser shows instead of a blank one when a navigation was refused or did not
 * load. It lives in the Bot's page, not in the app UI: the owner process does not know
 * the app language, so it says it in both, and it uses system colors (the app's theme tokens do
 * not exist there). No script; the host and error name are escaped plain text.
 */
export function noticePage(kind: NoticeKind, detail: { host: string; error?: string }) {
  const [title, body] = keys[kind];
  const values = { host: detail.host || "-", error: detail.error ?? "ERR_FAILED" };
  const section = (language: "zh" | "en") => {
    const t = createTranslator(language);
    return `<section lang="${language === "zh" ? "zh-CN" : "en"}"><h1>${escapeHtml(t(title))}</h1><p>${escapeHtml(t(body, values))}</p></section>`;
  };
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(
    createTranslator("zh")(title),
  )}</title><style>:root{color-scheme:light dark}body{margin:0;padding:48px 40px;font:15px/1.6 -apple-system,system-ui,sans-serif;background:Canvas;color:CanvasText}section{max-width:640px;margin:0 0 28px}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:GrayText}</style></head><body>${section("zh")}${section("en")}</body></html>`;
}
