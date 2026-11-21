// Small readers for other tools' configuration formats. They are deliberately partial: anything
// they do not understand throws, and the caller skips that file instead of guessing.

export class FormatError extends Error {
  constructor() {
    super("discovery_format_unsupported");
  }
}

/** JSON with comments and trailing commas (OpenCode's `.jsonc`, hand-edited `mcp.json` files). */
export function parseJsonc(text: string): unknown {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  // First index at or after `from` that is neither whitespace nor inside a comment.
  const significant = (from: number) => {
    let j = from;
    for (;;) {
      while (j < text.length && /\s/.test(text[j] as string)) j++;
      if (text.startsWith("//", j)) while (j < text.length && text[j] !== "\n") j++;
      else if (text.startsWith("/*", j)) {
        const end = text.indexOf("*/", j + 2);
        if (end < 0) throw new FormatError();
        j = end + 2;
      } else return j;
    }
  };
  while (i < text.length) {
    const char = text[i];
    if (char === '"') {
      // Strings are copied untouched, so a "," or "//" inside one is never rewritten.
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      if (i >= text.length) throw new FormatError();
      i++;
    } else if (char === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
      out.push(text.slice(start, i));
      i = significant(i);
      start = i;
    } else if (char === ",") {
      const next = significant(i + 1);
      if (text[next] === "}" || text[next] === "]") {
        out.push(text.slice(start, i));
        start = i + 1;
      }
      i++;
    } else i++;
  }
  out.push(text.slice(start));
  try {
    return JSON.parse(out.join(""));
  } catch {
    throw new FormatError();
  }
}

type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue };
type TomlTable = { [key: string]: TomlValue };

/**
 * The TOML subset Codex's `config.toml` uses for `[mcp_servers.*]`: tables with bare or quoted
 * dotted names, `key = value` with basic / literal strings, numbers, booleans, (multi-line)
 * arrays and inline tables. Multi-line strings, dates and arrays of tables throw.
 */
export function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  let table = root;
  let i = 0;
  const skipSpace = (newlines: boolean) => {
    for (;;) {
      const char = text[i];
      if (char === " " || char === "\t" || char === "\r" || (newlines && char === "\n")) i++;
      else if (char === "#") while (i < text.length && text[i] !== "\n") i++;
      else return;
    }
  };
  const key = (): string => {
    const char = text[i];
    if (char === '"' || char === "'") {
      const value = string();
      if (typeof value !== "string") throw new FormatError();
      return value;
    }
    const match = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
    if (!match) throw new FormatError();
    i += match[0].length;
    return match[0];
  };
  const dotted = (): string[] => {
    const parts = [key()];
    skipSpace(false);
    while (text[i] === ".") {
      i++;
      skipSpace(false);
      parts.push(key());
      skipSpace(false);
    }
    return parts;
  };
  const string = (): string => {
    const quote = text[i];
    if (text.startsWith(quote === '"' ? '"""' : "'''", i)) throw new FormatError();
    i++;
    let out = "";
    while (i < text.length && text[i] !== quote) {
      const char = text[i] as string;
      if (char === "\n") throw new FormatError();
      if (quote === '"' && char === "\\") {
        const escaped = text[i + 1];
        const simple: Record<string, string> = {
          n: "\n",
          t: "\t",
          r: "\r",
          '"': '"',
          "\\": "\\",
          b: "\b",
          f: "\f",
        };
        if (escaped && simple[escaped] !== undefined) {
          out += simple[escaped];
          i += 2;
        } else if (escaped === "u" || escaped === "U") {
          const length = escaped === "u" ? 4 : 8;
          const hex = text.slice(i + 2, i + 2 + length);
          if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== length) throw new FormatError();
          out += String.fromCodePoint(Number.parseInt(hex, 16));
          i += 2 + length;
        } else throw new FormatError();
        continue;
      }
      out += char;
      i++;
    }
    if (text[i] !== quote) throw new FormatError();
    i++;
    return out;
  };
  const value = (): TomlValue => {
    const char = text[i];
    if (char === '"' || char === "'") return string();
    if (char === "[") {
      i++;
      const items: TomlValue[] = [];
      for (;;) {
        skipSpace(true);
        if (text[i] === "]") {
          i++;
          return items;
        }
        items.push(value());
        skipSpace(true);
        if (text[i] === ",") i++;
        else if (text[i] !== "]") throw new FormatError();
      }
    }
    if (char === "{") {
      i++;
      const inline: TomlTable = {};
      skipSpace(false);
      if (text[i] === "}") {
        i++;
        return inline;
      }
      for (;;) {
        skipSpace(false);
        const path = dotted();
        if (text[i] !== "=") throw new FormatError();
        i++;
        skipSpace(false);
        assign(inline, path, value());
        skipSpace(false);
        if (text[i] === ",") i++;
        else if (text[i] === "}") {
          i++;
          return inline;
        } else throw new FormatError();
      }
    }
    const match = /^(true|false|[+-]?\d[\d_]*(?:\.\d+)?)/.exec(text.slice(i));
    if (!match?.[1]) throw new FormatError();
    i += match[1].length;
    if (match[1] === "true") return true;
    if (match[1] === "false") return false;
    return Number(match[1].replaceAll("_", ""));
  };
  const descend = (from: TomlTable, path: string[]): TomlTable => {
    let current = from;
    for (const part of path) {
      if (part === "__proto__" || part === "constructor" || part === "prototype")
        throw new FormatError();
      const existing = current[part];
      if (existing === undefined) current[part] = {};
      const next = current[part];
      if (!next || typeof next !== "object" || Array.isArray(next)) throw new FormatError();
      current = next as TomlTable;
    }
    return current;
  };
  const assign = (target: TomlTable, path: string[], item: TomlValue) => {
    const last = path.at(-1);
    if (!last || last === "__proto__" || last === "constructor" || last === "prototype")
      throw new FormatError();
    descend(target, path.slice(0, -1))[last] = item;
  };
  while (i < text.length) {
    skipSpace(true);
    if (i >= text.length) break;
    if (text[i] === "[") {
      if (text[i + 1] === "[") throw new FormatError();
      i++;
      skipSpace(false);
      table = descend(root, dotted());
      if (text[i] !== "]") throw new FormatError();
      i++;
    } else {
      const path = dotted();
      if (text[i] !== "=") throw new FormatError();
      i++;
      skipSpace(false);
      assign(table, path, value());
    }
    skipSpace(false);
    if (i < text.length && text[i] !== "\n") throw new FormatError();
  }
  return root;
}

/**
 * Codex `config.toml`, read leniently: the rest of the file (model settings, profiles, anything
 * newer than this reader) is never parsed. Each `[mcp_servers.<name>]` block, with its sub-tables
 * such as `.env`, is parsed on its own, so a server this reader cannot handle is undefined
 * instead of hiding the others.
 */
export function codexMcpServers(text: string): Record<string, unknown> {
  const blocks = new Map<string, string[]>();
  let current: string[] | undefined;
  let multiline: string | undefined;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (multiline) {
      // A table-looking line inside a multi-line string is text, not a header.
      if (line.includes(multiline)) multiline = undefined;
      current?.push(line);
      continue;
    }
    const header = /^\s*\[(?!\[)(.+)\]\s*(?:#.*)?$/.exec(line)?.[1];
    if (header !== undefined) {
      current = undefined;
      let path: string[] = [];
      try {
        path = tablePath(header);
      } catch {
        // A header this reader cannot parse is not an mcp_servers table it could use anyway.
      }
      if (path[0] === "mcp_servers" && path[1]) {
        current = blocks.get(path[1]) ?? [];
        blocks.set(path[1], current);
      }
    }
    current?.push(line);
    const quote = /"""|'''/.exec(line.replace(/#.*$/, ""))?.[0];
    if (quote && line.split(quote).length === 2) multiline = quote;
  }
  const servers: Record<string, unknown> = {};
  for (const [name, lines] of blocks) {
    try {
      servers[name] = (parseToml(lines.join("\n")).mcp_servers as TomlTable)[name];
    } catch {
      servers[name] = undefined;
    }
  }
  return servers;
}

/** The dotted key path of a table header, e.g. `mcp_servers."my server".env`. */
function tablePath(header: string): string[] {
  const path: string[] = [];
  let node: TomlValue | undefined = parseToml(`[${header}]\n`);
  while (node && typeof node === "object" && !Array.isArray(node)) {
    const keys = Object.keys(node);
    if (keys.length !== 1) break;
    const key = keys[0] as string;
    path.push(key);
    node = (node as TomlTable)[key];
  }
  return path;
}

/**
 * `name` / `description` from a SKILL.md front matter; nothing else of the file is kept. Block
 * scalars (`description: >` / `|`) are read as their text, on one line.
 */
export function skillFrontMatter(text: string, fallback: string) {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const end = normalized.startsWith("---\n") ? normalized.indexOf("\n---", 4) : -1;
  const fields = new Map<string, string>();
  if (end >= 0) {
    const lines = normalized.slice(4, end).split("\n");
    for (let index = 0; index < lines.length; index++) {
      const match = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(lines[index] as string);
      if (!match?.[1] || match[2] === undefined) continue;
      let value = match[2].trim();
      if (/^[>|][+-]?\d*\s*(?:#.*)?$/.test(value)) {
        // Folded (>) or literal (|) block scalar: the indented lines below are the value.
        const block: string[] = [];
        while (index + 1 < lines.length && /^(?:\s+\S|\s*$)/.test(lines[index + 1] as string))
          block.push((lines[++index] as string).trim());
        value = block.filter(Boolean).join(" ");
      } else if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      )
        value = value.slice(1, -1);
      else value = value.replace(/\s+#.*$/, "").trim();
      fields.set(match[1], value);
    }
  }
  const clean = (value: string, max: number) =>
    value
      .replace(/[\p{Cc}]/gu, " ")
      .trim()
      .slice(0, max);
  return {
    name: clean(fields.get("name") || fallback, 80) || fallback.slice(0, 80),
    description: clean(fields.get("description") ?? "", 1024),
  };
}
