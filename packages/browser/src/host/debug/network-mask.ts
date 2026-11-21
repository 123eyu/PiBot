import { randomBytes } from "node:crypto";
import { RpcError, RpcErrorCodes } from "@pibot/browser-contract/full";
import { maskXml } from "./network-xml.ts";

const uriCase = (text: string) => text.replace(/%[0-9a-f]{2}/gi, (part) => part.toUpperCase());

const sensitive = (name: string) => {
  const words = name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return (
    words.some((word) =>
      /^(key|auth|authorization|cookie|token|secret|password|passwd|session|sid|code|refresh|credential|credentials)$/.test(
        word,
      ),
    ) || /token|password|passwd|secret|authorization|cookie|apikey|sessionid/i.test(name)
  );
};
export const bodyMime = (mime: string) =>
  /^(?:application\/(?:json|[\w.+-]+\+json|x-www-form-urlencoded|xml|[\w.+-]+\+xml)|text\/xml)(?:;|$)/i.test(
    mime,
  );

/** Host-only vault: bounded, document-scoped, never serialized. */
export function createNetworkMask(redact: (value: string) => string) {
  let saturated = false;
  let generation = 0;
  const values = new Map<
    string,
    {
      value: string;
      name: string;
      site: string;
      kind: "network" | "cookie" | "localStorage" | "sessionStorage";
    }
  >();
  let bytes = 0;
  /** Bumped whenever `values` changes, so `known` rebuilds its match list only then. */
  let version = 0;
  let matcher: { version: number; variants: { id: string; value: string }[] } | undefined;
  const hide = (
    value: string,
    name: string,
    site: string,
    kind: "network" | "cookie" | "localStorage" | "sessionStorage" = "network",
  ) => {
    if (!value) return "«secret:unavailable»";
    if (value.length > 65536) {
      saturated = true;
      return "«secret:unavailable»";
    }
    for (const [id, entry] of values)
      if (
        entry.value === value &&
        entry.name === name &&
        entry.site === site &&
        entry.kind === kind
      )
        return `«secret:${id}»`;
    // Refuse growth rather than forget values still echoed elsewhere in the capture.
    if (values.size >= 256 || bytes + value.length * 12 > 4 * 1024 * 1024) {
      saturated = true;
      return "«secret:unavailable»";
    }
    const id = `h${randomBytes(16).toString("hex")}`;
    bytes += value.length * 12;
    values.set(id, { value, name, site, kind });
    version++;
    return `«secret:${id}»`;
  };
  const buildVariants = () =>
    [...values]
      .sort((a, b) => b[1].value.length - a[1].value.length)
      .flatMap(([id, { value }]) => {
        const variants = new Set([
          value,
          JSON.stringify(value).slice(1, -1),
          JSON.stringify(value).slice(1, -1).replaceAll("/", String.fromCharCode(92, 47)),
          Buffer.from(value).toString("base64"),
          Buffer.from(value).toString("base64").replace(/=+$/, ""),
          Buffer.from(value).toString("base64url"),
        ]);
        try {
          variants.add(encodeURIComponent(value));
          variants.add(encodeURIComponent(value).replace(/%20/g, "+"));
        } catch {
          // Lone surrogates have no URI encoding; their raw and JSON forms remain covered.
        }
        return [...variants].map((value) => ({ id, value: uriCase(value) }));
      })
      .sort((a, b) => b.value.length - a.value.length);
  const known = (input: string) => {
    if (saturated) return "[secret_output_withheld]";
    if (input.length > 1024 * 1024)
      throw new RpcError(RpcErrorCodes.invalidParams, "secret_output_withheld");
    // Called for every header and body; rebuilding every encoding of every captured value on each
    // call made a busy page (x.com) stall the desktop main thread for seconds (2026-11-18).
    if (matcher?.version !== version) matcher = { version, variants: buildVariants() };
    const { variants } = matcher;

    // Match original bytes only. Replacing a short value inside a replacement handle
    // corrupts it and can expand every later read of the ring.
    const replace = (source: string) => {
      const matching = uriCase(source);
      const matches = new Map<number, { end: number; id: string }>();
      for (const { id, value } of variants) {
        let start = matching.indexOf(value);
        while (start !== -1) {
          if (!matches.has(start)) matches.set(start, { end: start + value.length, id });
          if (matches.size > 100_000)
            throw new RpcError(RpcErrorCodes.invalidParams, "secret_output_withheld");
          start = matching.indexOf(value, start + 1);
        }
      }
      const ranges: { start: number; end: number; id: string }[] = [];
      for (const [start, { end, id }] of [...matches].sort((a, b) => a[0] - b[0])) {
        const previous = ranges.at(-1);
        if (previous && start < previous.end) previous.end = Math.max(previous.end, end);
        else ranges.push({ start, end, id });
      }
      const parts: string[] = [];
      let cursor = 0;
      for (const { start, end, id } of ranges) {
        parts.push(source.slice(cursor, start), `«secret:${id}»`);
        cursor = end;
      }
      parts.push(source.slice(cursor));
      return parts.join("");
    };
    return input
      .split(/(«secret:h[a-f0-9]{32}»|%C2%ABsecret%3Ah[a-f0-9]{32}%C2%BB)/gi)
      .map((part, index) =>
        index % 2 && values.has(decodeURIComponent(part).slice(8, -1)) ? part : replace(part),
      )
      .join("")
      .split(/(«secret:h[a-f0-9]{32}»)/g)
      .map((part, index) => (index % 2 && values.has(part.slice(8, -1)) ? part : redact(part)))
      .join("");
  };
  const protectHandles = (input: string, transform: (value: string) => string) =>
    input
      .split(/(«secret:h[a-f0-9]{32}»|%C2%ABsecret%3Ah[a-f0-9]{32}%C2%BB)/gi)
      .map((part, index) =>
        index % 2 && values.has(decodeURIComponent(part).slice(8, -1)) ? part : transform(part),
      )
      .join("");
  /** Credential-shaped tokens only; `text` adds the known-value pass and the redactor. */
  const tokens = (input: string, site = "") => {
    const auth = protectHandles(input, (part) =>
      part.replace(
        /\b(Bearer|Basic)\s+([^\s,;"<>]+)/gi,
        (_all, scheme: string, value: string) => `${scheme} ${hide(value, "authentication", site)}`,
      ),
    );
    const jwt = protectHandles(auth, (part) =>
      part.replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, (value) =>
        hide(value, "JWT", site),
      ),
    );
    return protectHandles(jwt, (part) =>
      part.replace(/\b[A-Za-z0-9_+/-]{32,}={0,2}/g, (value) => hide(value, "opaque token", site)),
    );
  };
  const text = (input: string, site = "") => known(tokens(input, site));
  const url = (input: string, base?: string) => {
    try {
      const value = new URL(input, base);
      if (!/^https?:$/.test(value.protocol)) return "[non-http URL]";
      value.username = "";
      value.password = "";
      value.hash = "";
      const pairs = [...value.searchParams];
      value.search = "";
      // Preserve duplicates; each sensitive value needs its own registration.
      for (const [name, item] of pairs)
        value.searchParams.append(name, sensitive(name) ? hide(item, name, value.origin) : item);
      return text(value.href, value.origin).slice(0, 8192);
    } catch {
      return "[invalid URL]";
    }
  };
  const body = (input: string, mime: string, site = ""): string | undefined => {
    if (input.length > 65536 || !bodyMime(mime)) return undefined;
    const type = mime.split(";")[0]?.toLowerCase() ?? "";
    let result: string;
    if (type.endsWith("json")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(input);
      } catch {
        return undefined;
      }
      const walk = (item: unknown, depth: number): unknown => {
        if (depth > 20) return "[omitted]";
        if (Array.isArray(item)) return item.map((value) => walk(value, depth + 1));
        if (item && typeof item === "object")
          return Object.fromEntries(
            Object.entries(item).map(([key, value]) => [
              key,
              sensitive(key)
                ? hide(typeof value === "string" ? value : JSON.stringify(value), key, site)
                : walk(value, depth + 1),
            ]),
          );
        // Leaves only hide token-shaped values; the whole result then goes through `text` once,
        // which applies the known values (JSON-escaped forms included) and the redactor.
        return typeof item === "string" ? tokens(item, site) : item;
      };
      const registerSensitiveLeaves = (item: unknown, depth: number, name = "secret") => {
        if (depth > 20) return;
        if (typeof item === "string" || typeof item === "number") {
          hide(String(item), name, site);
          return;
        }
        if (Array.isArray(item)) {
          for (const value of item) registerSensitiveLeaves(value, depth + 1, name);
          return;
        }
        if (item && typeof item === "object")
          for (const [key, value] of Object.entries(item))
            registerSensitiveLeaves(value, depth + 1, sensitive(key) ? key : name);
      };
      const registerSensitiveSubtrees = (item: unknown, depth: number) => {
        if (depth > 20 || !item || typeof item !== "object") return;
        if (Array.isArray(item)) {
          for (const value of item) registerSensitiveSubtrees(value, depth + 1);
          return;
        }
        for (const [key, value] of Object.entries(item)) {
          if (sensitive(key)) registerSensitiveLeaves(value, depth + 1, key);
          registerSensitiveSubtrees(value, depth + 1);
        }
      };
      registerSensitiveSubtrees(parsed, 0);
      result = JSON.stringify(walk(parsed, 0));
    } else if (type === "application/x-www-form-urlencoded") {
      // URLSearchParams tolerates broken escapes; those bodies are metadata-only.
      if (/%(?![0-9a-f]{2})/i.test(input)) return undefined;
      const pairs = [...new URLSearchParams(input)];
      for (const [name, value] of pairs) if (sensitive(name)) hide(value, name, site);
      result = new URLSearchParams(
        pairs.map(([name, value]) => [
          text(name, site),
          sensitive(name) ? hide(value, name, site) : text(value, site),
        ]),
      ).toString();
    } else {
      const xml = maskXml(input, sensitive, (value, name) => hide(value, name, site));
      if (xml === undefined) return undefined;
      result = xml;
    }
    return text(result, site);
  };
  return {
    get generation() {
      return generation;
    },
    text,
    body,
    url,
    known,
    snapshot<T>(input: T): T {
      const walk = (value: unknown, root = false): unknown => {
        if (typeof value === "string") return known(value);
        if (typeof value === "number") {
          const safe = known(String(value));
          if (safe !== String(value))
            throw new RpcError(RpcErrorCodes.invalidParams, "secret_output_withheld");
          return value;
        }
        if (Array.isArray(value)) return value.map((item) => walk(item));
        if (value && typeof value === "object")
          return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [root ? key : known(key), walk(item)]),
          );
        return value;
      };
      return walk(input, true) as T;
    },
    headers(headers: Record<string, string>, site = "") {
      const all = Object.entries(headers);
      if (
        all.length > 512 ||
        all.reduce((size, [key, value]) => size + key.length + value.length, 0) > 262144
      ) {
        saturated = true;
        return { omitted: "[secret_output_withheld]" };
      }
      const pairs = all.slice(0, 64);
      for (const [name, value] of all)
        if (sensitive(name)) {
          hide(value, name, site);
          text(value, site);
          if (/cookie/i.test(name))
            for (const pair of /^set-cookie$/i.test(name)
              ? value.split("\n").map((line) => line.split(";")[0] ?? "")
              : value.split(";")) {
              const equal = pair.indexOf("=");
              if (equal > 0) hide(pair.slice(equal + 1).trim(), name, site);
            }
        }
      const result = pairs.map(([name, value]) => {
        let safe: string;
        if (sensitive(name)) safe = hide(value, name, site);
        else if (/^(location|referer|content-location|origin)$/i.test(name))
          safe = url(value, site);
        else if (/^(link|refresh)$/i.test(name)) {
          // Only accept the standard URL-bearing forms; unknown syntax is metadata-only.
          safe = /^link$/i.test(name)
            ? value
                .replace(/<([^<>]+)>/g, (_all, target: string) => `<${url(target, site)}>`)
                .replace(
                  /(\b(?:anchor|url)\s*=\s*)(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^;\s"']+))/gi,
                  (
                    _all,
                    prefix: string,
                    double: string | undefined,
                    single: string | undefined,
                    bare: string | undefined,
                  ) => `${prefix}"${url(double ?? single ?? bare ?? "", site)}"`,
                )
                .replace(/https?:\/\/[^\s<>"']+/gi, (target) => url(target, site))
            : value.replace(
                /(url\s*=\s*)(.*)$/i,
                (_all, prefix: string, target: string) =>
                  `${prefix}${url(target.replace(/^["']|["']$/g, ""), site)}`,
              );
          if (safe === value) safe = "[URL header omitted]";
        } else {
          // Arbitrary echo headers may contain credential-bearing URLs too.
          safe = value.replace(/https?:\/\/[^\s<>"']+/gi, (target) => url(target, site));
        }
        return [text(name, site).slice(0, 256), text(safe, site).slice(0, 1024)];
      });
      return Object.fromEntries(
        pairs.length ? result.map(([name, value]) => [known(name ?? ""), known(value ?? "")]) : [],
      );
    },
    get(handle: string, site?: string) {
      const id = handle.replace(/^«secret:(h[a-f0-9]{32})»$/, "$1");
      const entry = values.get(id);
      return entry && (site === undefined || entry.site === site) ? entry : undefined;
    },
    capture(
      value: string,
      name: string,
      site: string,
      kind: "network" | "cookie" | "localStorage" | "sessionStorage" = "network",
    ) {
      const handle = hide(value, name, site, kind);
      if (!/^«secret:h[a-f0-9]{32}»$/.test(handle)) return undefined;
      const entry = values.get(handle.slice(8, -1));
      return entry ? { handle, ...entry } : undefined;
    },
    clear() {
      generation++;
      values.clear();
      version++;
      bytes = 0;
      saturated = false;
    },
  };
}
