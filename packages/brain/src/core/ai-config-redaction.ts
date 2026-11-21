import { basename, extname } from "node:path";

export type AiConfigRedaction =
  | { ok: true; text: string }
  | { ok: false; reason: "ai_config_unreadable" };
const hidden = "[REDACTED]";
const secretContainer = (key: string) =>
  /^(?:env|environment|headers|http_headers|credentials|auth)$/i.test(key);
const sensitiveKey = (key: string) =>
  /(?:^|[^a-z0-9])(?:api[_ -]?key|access[_ -]?key(?:[_ -]?id)?|secret|token|password|passwd|credential(?:s)?|authorization|cookie|private[_ -]?key|session(?:[_ -]?id)?|auth)(?:$|[^a-z0-9])/i.test(
    key,
  ) ||
  /(?:apiKey|accessKey|secretKey|clientSecret|refreshToken|accessToken|authToken|privateKey|password|passwd)$/i.test(
    key,
  ) ||
  /(?:^|[_-])(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)(?:$|[_-])/i.test(key);

function scalar(value: string): string {
  if (
    /\b(?:Bearer|Basic)\s+\S+/i.test(value) ||
    /-----BEGIN .*PRIVATE KEY-----/.test(value) ||
    /otpauth:\/\//i.test(value) ||
    /^(?:authorization|cookie|x-(?:api-key|auth-token|secret))\s*:/i.test(value)
  )
    return hidden;
  // URLs may carry basic authentication or access tokens even under an ordinary endpoint key.
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, (candidate) => {
      let url: URL;
      try {
        url = new URL(candidate);
      } catch {
        return candidate;
      }
      let changed = false;
      if (url.username || url.password) {
        url.username = "";
        url.password = "";
        changed = true;
      }
      for (const key of url.searchParams.keys())
        if (sensitiveKey(key)) {
          url.searchParams.set(key, hidden);
          changed = true;
        }
      return changed ? url.href : candidate;
    })
    .replace(
      /((?:--?|\/)(?:api[_-]?key|token|password|secret)(?:=|\s+))(?:("[^"]*"|'[^']*')|\S+)/gi,
      `$1${hidden}`,
    );
}

function structured(value: unknown, depth = 0): unknown {
  if (depth > 40) throw new Error("ai_config_unreadable");
  if (typeof value === "string") return scalar(value);
  if (Array.isArray(value))
    return value.map((item, index) =>
      typeof value[index - 1] === "string" &&
      /^(?:--?|\/)(?:api[_-]?key|token|password|secret)$/i.test(value[index - 1])
        ? hidden
        : structured(item, depth + 1),
    );
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sensitiveKey(key)
          ? hidden
          : secretContainer(key) && item && typeof item === "object"
            ? Object.fromEntries(Object.keys(item).map((name) => [name, hidden]))
            : structured(item, depth + 1),
      ]),
    );
  return value;
}

function parseJson(text: string): unknown {
  const output: string[] = [];
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? "";
    if (quoted) {
      output.push(char);
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      output.push(char);
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index++;
      output.push("\n");
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end < 0) throw new Error("ai_config_unreadable");
      index = end + 1;
      output.push(" ");
      continue;
    }
    if (char === ",") {
      let next = index + 1;
      while (next < text.length && /\s/.test(text[next] ?? "")) next++;
      if (text[next] === "}" || text[next] === "]") continue;
    }
    output.push(char);
  }
  const value: unknown = JSON.parse(output.join(""));
  if (!value || typeof value !== "object") throw new Error("ai_config_unreadable");
  return value;
}

function credentialStructure(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(credentialStructure);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, credentialStructure(item)]),
    );
  return hidden;
}

/** A conservative scalar subset shared by env, TOML and YAML. Complex/partial syntax refuses. */
function safeScalar(value: string): string {
  const raw = value.trim();
  if (!raw) return raw;
  if (raw.startsWith('"')) {
    const decoded: unknown = JSON.parse(raw);
    if (typeof decoded !== "string") throw new Error("ai_config_unreadable");
    return JSON.stringify(scalar(decoded));
  }
  if (raw.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(raw)) throw new Error("ai_config_unreadable");
    return JSON.stringify(scalar(raw.slice(1, -1).replace(/''/g, "'")));
  }
  if (/^[[{]/.test(raw)) return JSON.stringify(structured(parseJson(raw)));
  if (/[[\]{}&*!|>\\`]/.test(raw) || raw.includes("\u0000"))
    throw new Error("ai_config_unreadable");
  return scalar(raw);
}

function withoutComment(line: string): string {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === "\\") {
      escaped = true;
      continue;
    }
    if (quote && char === quote) quote = "";
    else if (!quote && (char === '"' || char === "'")) quote = char;
    else if (!quote && char === "#") return line.slice(0, index).trimEnd();
  }
  return line;
}

function lineFormat(text: string, format: "env" | "toml" | "yaml", hideAll = false): string {
  let saw = false;
  let privateTable = false;
  let privateIndent: number | undefined;
  const output = text.split(/\r?\n/).map((source) => {
    const line = withoutComment(source);
    const trim = line.trim();
    // Comments may contain old credentials and are unnecessary for understanding configuration.
    if (!trim || trim.startsWith("#") || (format === "yaml" && /^(---|\.\.\.)$/.test(trim)))
      return "";
    if (format === "toml" && trim.startsWith("[")) {
      const table = /^(\[{1,2})(.+?)(\]{1,2})$/.exec(trim);
      const segment = "(?:[A-Za-z0-9_-]+|\"(?:\\\\.|[^\"\\\\])*\"|'[^']*')";
      if (
        !table ||
        table[1]?.length !== table[3]?.length ||
        !new RegExp(`^${segment}(?:\\.${segment})*$`).test(table[2] ?? "")
      )
        throw new Error("ai_config_unreadable");
      privateTable =
        /(?:^|\.)(?:env|environment|headers|http_headers|credentials|auth|secrets)(?:$|\.)/i.test(
          (table[2] ?? "").replace(/["']/g, ""),
        );
      return line;
    }
    const pattern =
      format === "yaml"
        ? /^(\s*(?:-\s+)?)([A-Za-z0-9_.-]+)\s*:\s*(.*)$/
        : /^(\s*(?:export\s+)?)([A-Za-z0-9_.-]+)\s*=\s*(.*)$/;
    const match = pattern.exec(line);
    if (!match) throw new Error("ai_config_unreadable");
    const [, indent, key = "", raw = ""] = match;
    saw = true;
    const indentation = indent?.length ?? 0;
    if (privateIndent !== undefined && indentation <= privateIndent) privateIndent = undefined;
    const secret =
      hideAll ||
      sensitiveKey(key) ||
      secretContainer(key) ||
      privateTable ||
      privateIndent !== undefined;
    if (format === "yaml" && !raw.trim() && secret) privateIndent ??= indentation;
    const value = secret ? JSON.stringify(hidden) : safeScalar(raw);
    return `${indent}${key}${format === "yaml" ? ": " : "="}${value}`;
  });
  if (!saw && text.trim()) throw new Error("ai_config_unreadable");
  return output.join("\n");
}

/** Called before read_file text enters tool history. Never fall back to the original text. */
export function redactAiConfig(path: string, text: string): AiConfigRedaction {
  if (text.length > 2_000_000) return { ok: false, reason: "ai_config_unreadable" };
  try {
    const extension = extname(path).toLowerCase();
    const credentials = /(?:^|[._-])(?:auth|credentials?|tokens?|secrets?)(?:[._-]|$)/i.test(
      basename(path),
    );
    const project = (value: unknown) =>
      credentials ? credentialStructure(value) : structured(value);
    if (extension === ".jsonl" || extension === ".ndjson")
      return {
        ok: true,
        text: text
          .split(/\r?\n/)
          .filter((line) => line.trim())
          .map((line) => JSON.stringify(project(parseJson(line))))
          .join("\n"),
      };
    if (
      [".json", ".jsonc"].includes(extension) ||
      (![".toml", ".yaml", ".yml", ".env"].includes(extension) && /^[\s\uFEFF]*[[{]/.test(text))
    )
      return {
        ok: true,
        text: JSON.stringify(project(parseJson(text.replace(/^\uFEFF/, ""))), null, 2),
      };
    const name = basename(path).toLowerCase();
    const format =
      extension === ".toml"
        ? "toml"
        : [".yaml", ".yml"].includes(extension)
          ? "yaml"
          : name === ".env" || name.startsWith(".env.") || extension === ".env"
            ? "env"
            : undefined;
    if (!format) return { ok: false, reason: "ai_config_unreadable" };
    return { ok: true, text: lineFormat(text, format, credentials) };
  } catch {
    return { ok: false, reason: "ai_config_unreadable" };
  }
}
