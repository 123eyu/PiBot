import { parseArgs } from "node:util";
import type { EvalPricing } from "../../../dev/model-pricing.ts";

export function options(argv: string[]) {
  const { values: v } = parseArgs({
    args: argv,
    strict: true,
    options: {
      real: { type: "boolean" },
      help: { type: "boolean" },
      "base-url": { type: "string" },
      model: { type: "string" },
      api: { type: "string" },
      header: { type: "string", multiple: true },
      timeout: { type: "string" },
      "input-price": { type: "string" },
      "output-price": { type: "string" },
      "cache-read-price": { type: "string" },
      "cap-usd": { type: "string" },
    },
  });
  const number = (s: string | undefined, fallback: number, min: number, max: number) => {
    const n = Number(s ?? fallback);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error("invalid_number");
    return n;
  };
  const api = v.api ?? "openai-completions";
  if (
    ![
      "openai-completions",
      "openai-responses",
      "anthropic-messages",
      "google-generative-ai",
    ].includes(api)
  )
    throw new Error("invalid_api");
  const key = v.real ? process.env.PIBOT_EVAL_API_KEY : undefined;
  delete process.env.PIBOT_EVAL_API_KEY;
  const url = URL.parse(v["base-url"] ?? "");
  if (
    v.real &&
    (!key ||
      !url ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !v.model)
  )
    throw new Error("invalid_real_provider");
  const pricing: EvalPricing = {
    input: number(v["input-price"], v.real ? NaN : 1, 0, 10000),
    output: number(v["output-price"], v.real ? NaN : 2, 0, 10000),
    cacheRead: number(v["cache-read-price"], 0, 0, 10000),
  };
  if (pricing.input + pricing.output === 0 || pricing.cacheRead > pricing.input)
    throw new Error("invalid_pricing");
  const headers: Record<string, string> = {};
  for (const entry of v.header ?? []) {
    const colon = entry.indexOf(":");
    const name = entry.slice(0, colon),
      value = entry.slice(colon + 1).trim();
    if (
      colon < 1 ||
      !/^[!#$%&'*+.^_`|~0-9a-z-]{1,128}$/i.test(name) ||
      /[\r\n]/.test(value) ||
      value.startsWith("!") ||
      /authorization|cookie|token|key/i.test(name)
    )
      throw new Error("invalid_header");
    headers[name] = value;
  }
  return {
    real: v.real === true,
    help: v.help === true,
    api: api as
      | "openai-completions"
      | "openai-responses"
      | "anthropic-messages"
      | "google-generative-ai",
    key,
    baseUrl: url?.href.replace(/\/$/, ""),
    model: v.model,
    headers,
    pricing,
    cap: number(v["cap-usd"], 0.3, 0.01, 100),
    timeoutMs: number(v.timeout, 240, 100, 3600) * 1000,
  };
}
export type Options = ReturnType<typeof options>;

/** Reserve worst-case spend before dispatch; retries reserve again. No optimistic cache discount. */
export function budget(o: Options) {
  let reserved = 0;
  let blocked: "budget_cap" | "budget_output_bound_missing" | undefined;
  return {
    get blocked() {
      return blocked;
    },
    get reserved() {
      return reserved;
    },
    reserve(body: string) {
      const raw = JSON.parse(body) as Record<string, unknown>;
      const generation = raw.generationConfig as Record<string, unknown> | undefined;
      const max = Number(
        raw.max_tokens ??
          raw.max_completion_tokens ??
          raw.max_output_tokens ??
          generation?.maxOutputTokens,
      );
      if (!Number.isSafeInteger(max) || max < 1) {
        blocked = "budget_output_bound_missing";
        throw new Error(blocked);
      }
      // A UTF-8 byte per input token plus protocol overhead is a deliberately conservative bound.
      const cost =
        ((Buffer.byteLength(body) + 4096) * o.pricing.input + max * o.pricing.output) / 1e6;
      if (reserved + cost > o.cap) {
        blocked = "budget_cap";
        throw new Error(blocked);
      }
      reserved += cost;
    },
  };
}
