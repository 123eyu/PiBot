import type { ExecRedactor } from "../core/types.ts";

export interface SecretOutputValue {
  handle: string;
  value: string;
}
export const SECRET_OUTPUT_WITHHELD = "secret_output_withheld";
const LIMIT = 1024 * 1024;
const uriCase = (text: string) => text.replace(/%[0-9a-f]{2}/gi, (part) => part.toUpperCase());

/** Match original bytes once, so even a one-character secret cannot corrupt a replacement. */
export function createSecretOutputMask(values: readonly SecretOutputValue[]) {
  if (values.length > 256) throw new Error(SECRET_OUTPUT_WITHHELD);
  const handles = new Set(values.map(({ handle }) => handle));
  const variants = values
    .flatMap(({ handle, value }) => {
      if (!value || value.includes("\0") || !/^«secret:h[a-f0-9]{32}»$/.test(handle))
        throw new Error(SECRET_OUTPUT_WITHHELD);
      const forms = new Set([
        value,
        JSON.stringify(value).slice(1, -1),
        JSON.stringify(value).slice(1, -1).replaceAll("/", String.fromCharCode(92, 47)),
        Buffer.from(value).toString("base64"),
        Buffer.from(value).toString("base64").replace(/=+$/, ""),
        Buffer.from(value).toString("base64url"),
      ]);
      try {
        forms.add(encodeURIComponent(value));
        forms.add(encodeURIComponent(value).replace(/%20/g, "+"));
      } catch {
        // Invalid Unicode has no URL form; its original and JSON forms are still scanned.
      }
      return [...forms].map((text) => ({ text: uriCase(text), handle }));
    })
    .sort((a, b) => b.text.length - a.text.length);
  if (variants.reduce((size, { text }) => size + text.length, 0) > 4 * LIMIT)
    throw new Error(SECRET_OUTPUT_WITHHELD);
  return (input: string) => {
    if (input.length > LIMIT) throw new Error(SECRET_OUTPUT_WITHHELD);
    const matches = new Map<number, { end: number; handle: string }>();
    // Preserve valid handles, which contain no raw value by construction.
    return input
      .split(/(«secret:h[a-f0-9]{32}»)/g)
      .map((part, index) => {
        if (index % 2 && handles.has(part)) return part;
        matches.clear();
        const matching = uriCase(part);
        for (const { text, handle } of variants) {
          let start = matching.indexOf(text);
          while (start !== -1) {
            if (!matches.has(start)) matches.set(start, { end: start + text.length, handle });
            if (matches.size > 100_000) throw new Error(SECRET_OUTPUT_WITHHELD);
            start = matching.indexOf(text, start + 1);
          }
        }
        const ranges: { start: number; end: number; handle: string }[] = [];
        for (const [start, { end, handle }] of [...matches].sort((a, b) => a[0] - b[0])) {
          const last = ranges.at(-1);
          if (last && start < last.end) last.end = Math.max(last.end, end);
          else ranges.push({ start, end, handle });
        }
        const result: string[] = [];
        let cursor = 0;
        for (const { start, end, handle } of ranges) {
          result.push(part.slice(cursor, start), handle);
          cursor = end;
        }
        result.push(part.slice(cursor));
        return result.join("");
      })
      .join("");
  };
}

/** Buffer merged stdout/stderr before publishing; neither chunks nor channels may split a secret. */
export function secretOutputRedactor(
  base: ExecRedactor,
  values: readonly SecretOutputValue[],
): ExecRedactor {
  const mask = createSecretOutputMask(values);
  const redact = (text: string) => {
    try {
      return mask(text)
        .split(/(«secret:h[a-f0-9]{32}»)/g)
        .map((part, index) => (index % 2 ? part : base.redact(part)))
        .join("");
    } catch {
      return SECRET_OUTPUT_WITHHELD;
    }
  };
  let chunks: string[] = [];
  let size = 0;
  let failed = false;
  let active = 0;
  return {
    redact,
    stream() {
      active++;
      let finished = false;
      return {
        push(text) {
          if (finished) return "";
          size += text.length;
          if (size > LIMIT) {
            failed = true;
            chunks = [];
          }
          if (!failed) chunks.push(text);
          return "";
        },
        finish() {
          if (finished) return "";
          finished = true;
          if (--active) return "";
          const safe = failed ? SECRET_OUTPUT_WITHHELD : redact(chunks.join(""));
          chunks = [];
          size = 0;
          failed = false;
          return safe;
        },
      };
    },
  };
}
