export type BlockedPageReason = "http_status" | "anti_bot_page" | "js_required";

// Known challenge copy, not generic mentions of CAPTCHA/JavaScript in an article. Short-page
// limits avoid treating an ordinary article quoting these messages as a challenge page.
const CHALLENGES = [
  /unusual traffic from (?:your computer|this) network/i, // Google /sorry/.
  /having trouble accessing Google Search/i, // Google's fetch-only refusal page.
  /(?:just a moment|attention required)[\s\S]{0,400}(?:cloudflare|checking|verify)/i,
  /(?:verify you(?:'|’)re human|verify that you are human|checking your browser)/i,
  /unfortunately, bots use duckduckgo too|please complete the following challenge/i,
] as const;
const JS_REQUIRED =
  /enable javascript|javascript (?:is )?required|turn on javascript|请启用\s*javascript|需要启用\s*javascript/i;

/** Fixed bounded facts only; accepts HTTP HTML or already-rendered readable text. */
export function blockedPage(
  response: { status: number; url?: string },
  text: string,
): BlockedPageReason | undefined {
  const sample = text.slice(0, 12_000);
  // Keep noscript copy: the normal readable-text extractor intentionally removes it.
  const visible = sample
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const challenge =
    visible.length <= 3000 &&
    (CHALLENGES.some((rule) => rule.test(visible)) ||
      // Chinese articles often discuss 人机验证; only a title or tiny challenge body is evidence.
      /<title[^>]*>\s*(?:人机验证|请完成(?:安全|验证码)验证)[！!。\s]*<\/title>/i.test(sample) ||
      (visible.length <= 80 &&
        /^(?:请完成(?:安全|验证码)验证|人机验证)(?:[！!。:：\s]|$)/.test(visible)) ||
      /<(?:title)[^>]*>\s*(?:Just a moment|Attention Required)[.!…\s]*(?:<|\|)/i.test(sample) ||
      /(?:id=["'](?:challenge-form|anomaly-form)|class=["'][^"']*cf-chl)/i.test(sample));
  let sorry = false;
  if (response.url) {
    try {
      const url = new URL(response.url);
      sorry = /(^|\.)google\.[a-z.]+$/i.test(url.hostname) && url.pathname.startsWith("/sorry/");
    } catch {
      // Classifier has no authority to navigate; malformed URLs contribute no evidence.
    }
  }
  if (challenge || sorry)
    return [403, 429, 503].includes(response.status) ? "http_status" : "anti_bot_page";
  if (visible.length <= 240 && JS_REQUIRED.test(visible)) return "js_required";
  return undefined;
}
