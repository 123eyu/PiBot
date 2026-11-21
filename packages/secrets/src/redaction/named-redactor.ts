import type { Redactor } from "../index.ts";
import { keyPattern, keyPrefixes } from "./redaction-patterns.ts";

export interface NamedRedactor extends Redactor {
  addNamed(name: string, value: string, browserHandle?: string): void;
  /** Detection is separate from replacement: a replacement must never hide a later match. */
  contains(value: unknown): string[];
  stream(): { push(text: string): string; finish(): string };
}
const uriCase = (text: string) => text.replace(/%[0-9a-f]{2}/gi, (part) => part.toUpperCase());

type Range = { start: number; end: number; names: Set<string> };

export class NamedRedactionBudgetError extends Error {
  readonly code = "redaction_budget_exceeded" as const;
  constructor() {
    super("redaction_budget_exceeded");
  }
}

/** Old values intentionally live until process exit: deleted/replaced credentials may still be in flight. */
export function withNamedRedaction(anonymous: Redactor): NamedRedactor {
  const values = new Map<string, Set<string>>();
  const prefixes = new Map<string, Uint32Array>();
  const browserValues = new Set<string>();
  const browserHandles = new Set<string>();
  let namedBytes = 0;
  const forms = (value: string, browser: boolean) => {
    const variants = new Set([value, JSON.stringify(value).slice(1, -1)]);
    if (browser) {
      const base64 = btoa(
        Array.from(new TextEncoder().encode(value), (byte) => String.fromCharCode(byte)).join(""),
      );
      variants.add(JSON.stringify(value).slice(1, -1).replaceAll("/", String.fromCharCode(92, 47)));
      variants.add(base64);
      variants.add(base64.replace(/=+$/, ""));
      variants.add(base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
      try {
        variants.add(encodeURIComponent(value));
        variants.add(encodeURIComponent(value).replace(/%20/g, "+"));
      } catch {
        /* Invalid Unicode has no URL form. */
      }
    }
    return variants;
  };
  const register = (value: string, name?: string) => {
    for (const variant of forms(value, name === "BROWSER_SECRET")) {
      const names = values.get(variant) ?? new Set<string>();
      if (name) names.add(name);
      values.set(variant, names);
      if (!prefixes.has(variant)) {
        const table = new Uint32Array(variant.length);
        for (let i = 1, n = 0; i < variant.length; i++) {
          while (n && variant[i] !== variant[n]) n = table[n - 1] ?? 0;
          if (variant[i] === variant[n]) n++;
          table[i] = n;
        }
        prefixes.set(variant, table);
      }
    }
  };
  const ranges = (text: string): Range[] => {
    const found: Range[] = [];
    const canonical = uriCase(text);
    for (const [value, names] of values) {
      const matching = names.has("BROWSER_SECRET") ? canonical : text;
      const needle = names.has("BROWSER_SECRET") ? uriCase(value) : value;
      let start = matching.indexOf(needle);
      while (start !== -1) {
        found.push({ start, end: start + value.length, names: new Set(names) });
        start = matching.indexOf(needle, start + 1);
      }
    }
    for (const match of text.matchAll(keyPattern))
      found.push({ start: match.index, end: match.index + match[0].length, names: new Set() });
    found.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged: Range[] = [];
    for (const item of found) {
      const last = merged.at(-1);
      if (last && item.start < last.end) {
        last.end = Math.max(last.end, item.end);
        for (const name of item.names) last.names.add(name);
      } else merged.push(item);
    }
    return merged;
  };
  const redactPart = (text: string) => {
    const parts: string[] = [];
    let cursor = 0;
    for (const item of ranges(text)) {
      parts.push(
        anonymous.redact(text.slice(cursor, item.start)),
        item.names.size ? `[密钥 ${[...item.names].sort().join(", ")}]` : "[REDACTED]",
      );
      cursor = item.end;
    }
    parts.push(anonymous.redact(text.slice(cursor)));
    return parts.join("");
  };
  // Bot browser handles contain random ids, never raw material. Preserve them even for very short values.
  const redact = (text: string) =>
    text
      .split(/(«secret:h[a-f0-9]{32}»)/g)
      .map((part, index) => (index % 2 && browserHandles.has(part) ? part : redactPart(part)))
      .join("");
  const contains = (input: unknown): string[] => {
    const names = new Set<string>();
    const visit = (value: unknown) => {
      if (typeof value === "string") {
        for (const item of ranges(
          value.replace(/«secret:h[a-f0-9]{32}»/g, (handle) =>
            browserHandles.has(handle) ? "" : handle,
          ),
        )) {
          if (!item.names.size) names.add("REDACTED");
          for (const name of item.names) names.add(name);
        }
      } else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object")
        for (const [key, item] of Object.entries(value)) {
          visit(key);
          visit(item);
        }
    };
    visit(input);
    return [...names].sort();
  };
  return {
    add(value) {
      anonymous.add(value);
      // Anonymous compatibility keeps its historical minimum; named credentials never silently skip short values.
      if (value.length >= 8) register(value);
    },
    addNamed(name, value, browserHandle) {
      if (
        browserHandle &&
        (name !== "BROWSER_SECRET" ||
          !/^«secret:h[a-f0-9]{32}»$/.test(browserHandle) ||
          (!browserHandles.has(browserHandle) && browserHandles.size >= 256))
      )
        throw new NamedRedactionBudgetError();
      if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name) || !value || value.includes("\0"))
        throw new TypeError("Invalid named secret");
      // Browser secrets are cumulative for this redactor's process lifetime. Never evict:
      // in-flight outputs must remain protected after profile clearing.
      if (name === "BROWSER_SECRET" && !browserValues.has(value)) {
        const bytes = [...forms(value, true)].reduce((sum, form) => sum + form.length * 6, 0);
        if (browserValues.size >= 256 || namedBytes + bytes > 4 * 1024 * 1024)
          throw new NamedRedactionBudgetError();
        browserValues.add(value);
        namedBytes += bytes;
      }
      register(value, name);
      if (browserHandle) browserHandles.add(browserHandle);
    },
    redact,
    contains,
    stream() {
      let pending = "";
      let saturated = false;
      return {
        push(text) {
          if (saturated) return "";
          pending += text;
          // Hold only possible key suffixes; ordinary text must not wait for a 512-char buffer.
          let hold = 0;
          for (const prefix of keyPrefixes) {
            for (let width = 1; width < prefix.length; width++) {
              const start = pending.length - width;
              if (
                pending.endsWith(prefix.slice(0, width)) &&
                (start === 0 || !/\w/.test(pending[start - 1] ?? ""))
              )
                hold = Math.max(hold, width);
            }
            const start = pending.lastIndexOf(prefix);
            if (start < 0 || (start > 0 && /\w/.test(pending[start - 1] ?? ""))) continue;
            const tail = pending.slice(start + prefix.length);
            if (/^[A-Za-z0-9_-]*$/.test(tail)) hold = Math.max(hold, prefix.length + tail.length);
          }
          // KMP avoids quadratic suffix checks for long registered values.
          for (const [value, table] of prefixes) {
            let n = 0;
            const width = Math.min(value.length - 1, pending.length);
            const tail = width ? pending.slice(-width) : "";
            for (let i = 0; i < tail.length; i++) {
              const char = tail[i];
              while (n && char !== value[n]) n = table[n - 1] ?? 0;
              if (char === value[n]) n++;
            }
            hold = Math.max(hold, n);
          }
          let end = pending.length - hold;
          // An overlapping full value and partial suffix must stay raw until both are resolved.
          for (const item of ranges(pending))
            if (item.start < end && item.end > end) end = item.start;
          const safe = redact(pending.slice(0, end));
          pending = pending.slice(end);
          let maxWidth = 0;
          for (const value of prefixes.keys()) maxWidth = Math.max(maxWidth, value.length);
          if (pending.length > Math.max(64 * 1024, maxWidth * 2)) {
            // Pathological overlap can keep a merged range open forever. Stop retaining raw
            // bytes and mask the remainder of this stream rather than grow unbounded or leak.
            pending = "";
            saturated = true;
            return `${safe}[REDACTED]`;
          }
          return safe;
        },
        finish() {
          const safe = redact(pending);
          pending = "";
          return safe;
        },
      };
    },
  };
}
