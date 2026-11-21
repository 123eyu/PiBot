// "pure computation" verdicts for script code (files and -c / -e). A pure verdict lets a
// run be judged like a read-only command, so every check here errs towards "not pure": anything a
// scanner does not fully understand (an escape outside a string, an ambiguous `/`, a computed
// member, a construct a language could use to reach files, processes or the network) makes the
// code unproven and the run asks as it always did. Allowlists, never blocklists, decide what
// counts: names that are not on a list are refused, except where a comment says why a closed set
// of names (a language's own globals) is the boundary instead.
import { builtinModules } from "node:module";

export type PureLanguage = "python" | "javascript" | "lua" | "php" | "ruby" | "perl" | "powershell";
export const PURE_CODE_MAX = 64 * 1024;

export function pureCode(language: PureLanguage, code: string): boolean {
  if (code.length > PURE_CODE_MAX) return false;
  if (language === "python") return purePython(code);
  if (language === "javascript") return pureJavaScript(code);
  if (language === "lua") return pureLua(code);
  if (language === "php") return purePhp(code);
  // Ruby and Perl call methods without parentheses and on any value (`system "x"`, `open "|x"`,
  // `send`, `qx`, `<>` reading every argument file), and PowerShell reaches .NET and every cmdlet
  // by name: no conservative token allowlist proves them pure, so their runs keep asking (a read
  // script file can still be pre-authorized for a routine by its digest).
  return false;
}

const PYTHON_PURE_MODULES = new Set([
  "json",
  "sys",
  "re",
  "math",
  "datetime",
  "collections",
  "itertools",
  "functools",
  "statistics",
  "decimal",
  "fractions",
  "textwrap",
  "typing",
  "dataclasses",
  "enum",
  "time",
  "hashlib",
  "base64",
  "bisect",
  "heapq",
]);
// The sys members a pure script uses; sys.modules / _getframe / exc_info reach other code.
const PYTHON_SYS = new Set([
  "stdin",
  "stdout",
  "stderr",
  "argv",
  "exit",
  "maxsize",
  "version",
  "version_info",
  "platform",
  "byteorder",
  "float_info",
  "getrecursionlimit",
  "setrecursionlimit",
]);

/**
 * Builtins are always in scope, so the names that open files, evaluate text or reach attributes
 * by name are refused as bare words too (`f = open` is as good as `open(`). Frame and code
 * objects (`gi_frame.f_builtins`) lead back to every builtin; `get_type_hints` and
 * `singledispatch` evaluate string annotations.
 */
function purePython(code: string): boolean {
  if (pythonOtherCoding(code) || code.includes(PYTHON_ZIP_END)) return false;
  // Python folds identifiers with NFKC (`ｅｘｅｃ` is `exec`), so the folded text must pass too.
  const folded = code.normalize("NFKC");
  return purePythonText(code) && (folded === code || purePythonText(folded));
}
/** A zip archive's end record: `python3 file` runs a zip's `__main__.py`, not the bytes read. */
export const PYTHON_ZIP_END = "PK\u0005\u0006";
/**
 * Security review C3: a PEP 263 declaration in the first two lines makes Python decode the file
 * with that codec (`utf-7` turns `+…-` into new source lines), so only UTF-8 and ASCII, which
 * read as the text policy sees, are accepted. Any `coding[:=]` there counts, comment or not.
 */
export function pythonOtherCoding(code: string): boolean {
  for (const line of code.replace(/^﻿/u, "").split(/\r\n|\r|\n/u, 3)) {
    const name = /coding[:=][ \t]*([-\w.]+)/u.exec(line)?.[1];
    if (name && !/^(?:utf-?8|ascii|us-ascii)$/u.test(name.toLowerCase().replaceAll("_", "-")))
      return true;
  }
  return false;
}
function purePythonText(code: string): boolean {
  if (
    /\b(?:open|eval|exec|compile|getattr|setattr|delattr|globals|locals|vars|input|breakpoint|help|memoryview|get_type_hints|ForwardRef|singledispatch|singledispatchmethod|evaluate_forward_ref)\b/u.test(
      code,
    )
  )
    return false;
  if (/__\w+__/u.test(code.replace(/__name__\s*==\s*["']__main__["']/gu, ""))) return false;
  if (/\.(?:f|gi|cr|ag|tb|co)_\w+/u.test(code)) return false;
  // Imports count only as whole lines of their own; an `import` anywhere else (after `;`, in a
  // string, in a multi-line form) is not proven and makes the code unproven.
  let imports = 0;
  let body = code;
  for (const match of code.matchAll(PYTHON_IMPORT_LINE)) {
    imports++;
    body = body.replace(match[0], "");
    const from = match[1];
    const names = (from ? [from] : (match[3] ?? "").split(",")).map(
      (part) =>
        part
          .trim()
          .split(/\s+as\s+/u)[0]
          ?.split(".")[0] ?? "",
    );
    if (names.some((name) => !PYTHON_PURE_MODULES.has(name))) return false;
    // `import sys as s` / `from sys import modules` would bypass the member check below.
    if (/\bsys\b/u.test(match[3] ?? "") && /\bas\b/u.test(match[3] ?? "")) return false;
    if (
      from === "sys" &&
      (match[2] ?? "")
        .replace(/[()]/gu, "")
        .split(",")
        .some((name) => !PYTHON_SYS.has(name.trim().split(/\s+as\s+/u)[0] ?? ""))
    )
      return false;
  }
  if ((code.match(/\bimport\b/gu) ?? []).length !== imports) return false;
  for (const match of body.matchAll(/\bsys\b(\s*\.\s*(\w+))?/gu))
    if (!PYTHON_SYS.has(match[2] ?? "")) return false;
  return true;
}
const PYTHON_IMPORT_LINE =
  /^[ \t]*(?:from[ \t]+([\w.]+)[ \t]+import[ \t]+(\(?[\w, \t*]+\)?)|import[ \t]+([\w., \t]+))[ \t]*(?:#[^\n]*)?$/gmu;

// ---------------------------------------------------------------------------------------------
// JavaScript (Node). `node -e` exposes every built-in module as a global (`fs`, `child_process`),
// so the boundary is: a root name must be on JS_ALLOWED, or must not be any name Node itself
// defines (this runtime's globals and built-in modules plus a fixed list for other versions). A
// name Node does not define is the script's own binding or a ReferenceError, never a capability.
// Members that reach constructors, prototypes, frames or internals are refused, and computed
// access (`x[k]`) is refused unless the key is a literal, because a computed key can spell any of
// them.
const JS_ALLOWED = new Set([
  "console",
  "JSON",
  "Math",
  "Number",
  "String",
  "Array",
  "Object",
  "Date",
  "RegExp",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Boolean",
  "BigInt",
  "Symbol",
  "Promise",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "URIError",
  "AggregateError",
  "Intl",
  "Infinity",
  "NaN",
  "undefined",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURIComponent",
  "decodeURIComponent",
  "encodeURI",
  "decodeURI",
  "Buffer",
  "TextEncoder",
  "TextDecoder",
  "URL",
  "URLSearchParams",
  "structuredClone",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "setImmediate",
  "clearImmediate",
  "queueMicrotask",
  "atob",
  "btoa",
  "ArrayBuffer",
  "DataView",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int8Array",
  "Uint16Array",
  "Int16Array",
  "Uint32Array",
  "Int32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);
const JS_PROCESS = new Set(["stdin", "stdout", "stderr", "argv", "exit", "exitCode"]);
const JS_KNOWN = new Set([
  ...Object.getOwnPropertyNames(globalThis),
  ...builtinModules.map((name) => name.replace(/^node:/u, "").split("/")[0] ?? name),
  // Wrapper bindings and globals other Node versions or runtimes define.
  "require",
  "module",
  "exports",
  "__filename",
  "__dirname",
  "global",
  "globalThis",
  "process",
  "fetch",
  "WebSocket",
  "EventSource",
  "navigator",
  "Navigator",
  "localStorage",
  "sessionStorage",
  "Storage",
  "Worker",
  "SharedWorker",
  "XMLHttpRequest",
  "importScripts",
  "eval",
  "Function",
  "Reflect",
  "Proxy",
  "WebAssembly",
  "Atomics",
  "SharedArrayBuffer",
  "FinalizationRegistry",
  "WeakRef",
  "Deno",
  "Bun",
  "sqlite",
  "test",
  "sea",
  "this",
  "arguments",
]);
const JS_FORBIDDEN_WORDS = new Set(["this", "with", "arguments", "import", "export", "eval"]);
const JS_FORBIDDEN_MEMBERS = new Set([
  "constructor",
  "prototype",
  "caller",
  "callee",
  "arguments",
  "getPrototypeOf",
  "setPrototypeOf",
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
  "getOwnPropertyNames",
  "getOwnPropertySymbols",
  "defineProperty",
  "defineProperties",
  "prepareStackTrace",
  "captureStackTrace",
  "mainModule",
  "binding",
]);
// Reserved words after which `/` starts a regular expression and `[` an array, not a division or
// a member. `of`, `yield` and `await` are also ordinary names in sloppy scripts, so a `/` after
// them is ambiguous and refused, and a `[` after them is checked as a member.
const JS_EXPRESSION_AFTER_WORD = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "const",
  "var",
]);
const JS_CONTEXTUAL_WORDS = new Set(["of", "yield", "await"]);
const JS_NUMBER = /^(?:0[xXoObB][\da-fA-F_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?)n?/u;
const JS_LINE_END = /[\n\r]/u;

interface Skeleton {
  /** Code with comments removed and every literal replaced by `"<index>"` or `0`. */
  text: string;
  strings: string[];
}

/**
 * Blank out comments and literals so only code remains. Returns undefined for anything that would
 * make the skeleton differ from what the engine executes: a backslash or non-ASCII character
 * outside a literal (unicode escapes in names), `#` (private names), an unterminated literal, or
 * a `/` whose meaning depends on more than the previous token.
 */
function jsSkeleton(code: string): Skeleton | undefined {
  // HTML-like comments (`<!--`, `-->`) and U+2028/9 line ends change where a comment ends.
  if (/<!--|-->|[\u2028\u2029]/u.test(code)) return undefined;
  const strings: string[] = [];
  const out: string[] = [];
  const braces: ("{" | "${")[] = [];
  const parenOwners: string[] = [];
  let i = code.startsWith("#!") ? code.indexOf("\n") + 1 || code.length : 0;
  let prev: "start" | "punct" | "word" | "value" | "close-paren" | "close-brace" = "start";
  let prevWord = "";
  let prevMember = false;
  let prevPunct = "";
  let closedOwner = "";
  const literal = (text: string) => {
    strings.push(text);
    out.push(` "${strings.length - 1}" `);
    prev = "value";
  };
  // Scans template text from i up to the closing backtick or the next `${`.
  const template = (): boolean => {
    while (i < code.length) {
      const c = code[i] as string;
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        i++;
        out.push(" 0 ");
        prev = "value";
        return true;
      }
      if (c === "$" && code[i + 1] === "{") {
        i += 2;
        braces.push("${");
        out.push(" ( ");
        prev = "punct";
        prevPunct = "(";
        return true;
      }
      i++;
    }
    return false;
  };
  while (i < code.length) {
    const c = code[i] as string;
    if (/\s/u.test(c)) {
      out.push(c === "\n" ? "\n" : " ");
      i++;
      continue;
    }
    if (c === "/" && code[i + 1] === "/") {
      while (i < code.length && !JS_LINE_END.test(code[i] as string)) i++;
      continue;
    }
    if (c === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      if (end < 0) return undefined;
      i = end + 2;
      out.push(" ");
      continue;
    }
    if (c === "'" || c === '"') {
      let text = "";
      i++;
      for (;;) {
        const d = code[i];
        if (d === undefined || JS_LINE_END.test(d)) return undefined;
        i++;
        if (d === c) break;
        if (d === "\\") {
          text += code[i] ?? "";
          i++;
          continue;
        }
        text += d;
      }
      literal(text);
      continue;
    }
    if (c === "`") {
      i++;
      if (!template()) return undefined;
      continue;
    }
    if (c === "/") {
      const word = prev === "word" && !prevMember;
      const regex =
        prev === "start" ||
        prev === "punct" ||
        (word && JS_EXPRESSION_AFTER_WORD.has(prevWord)) ||
        (prev === "close-paren" && ["if", "while", "for", "with"].includes(closedOwner));
      // `a++ / b`, `} /x/` and `of / x` read differently depending on context the skeleton
      // cannot see.
      if (
        prev === "close-brace" ||
        (prev === "punct" && ["++", "--"].includes(prevPunct)) ||
        (word && JS_CONTEXTUAL_WORDS.has(prevWord))
      )
        return undefined;
      if (regex) {
        let inClass = false;
        i++;
        for (;;) {
          const d = code[i];
          if (d === undefined || JS_LINE_END.test(d)) return undefined;
          i++;
          if (d === "\\") {
            i++;
            continue;
          }
          if (d === "[") inClass = true;
          else if (d === "]") inClass = false;
          else if (d === "/" && !inClass) break;
        }
        while (/[a-z]/u.test(code[i] ?? "")) i++;
        out.push(" 0 ");
        prev = "value";
        continue;
      }
    }
    if (c === "\\" || c === "#" || c.charCodeAt(0) > 0x7e) return undefined;
    const word = /^[A-Za-z_$][\w$]*/u.exec(code.slice(i, i + 256))?.[0];
    if (word) {
      out.push(word);
      i += word.length;
      prevMember = prev === "punct" && prevPunct === ".";
      prev = "word";
      prevWord = word;
      continue;
    }
    const number = JS_NUMBER.exec(code.slice(i, i + 256))?.[0];
    if (number) {
      out.push(" 0 ");
      i += number.length;
      prev = "value";
      continue;
    }
    if (c === "{") braces.push("{");
    if (c === "}") {
      const top = braces.pop();
      if (top === "${") {
        out.push(" ) ");
        i++;
        if (!template()) return undefined;
        continue;
      }
      out.push("}");
      i++;
      prev = "close-brace";
      continue;
    }
    if (c === "(") parenOwners.push(prev === "word" && !prevMember ? prevWord : "");
    if (c === ")") {
      closedOwner = parenOwners.pop() ?? "";
      out.push(")");
      i++;
      prev = "close-paren";
      continue;
    }
    if (c === "]") {
      out.push("]");
      i++;
      prev = "value";
      continue;
    }
    const pair = code.slice(i, i + 2);
    prevPunct = pair === "++" || pair === "--" ? pair : c;
    out.push(prevPunct);
    i += prevPunct.length;
    prev = "punct";
  }
  return braces.length ? undefined : { text: out.join(""), strings };
}

const before = (text: string, index: number) => {
  let j = index - 1;
  while (j >= 0 && /\s/u.test(text[j] as string)) j--;
  return { char: text[j] ?? "", index: j };
};
const after = (text: string, index: number) => {
  let j = index;
  while (j < text.length && /\s/u.test(text[j] as string)) j++;
  return { char: text[j] ?? "", index: j };
};
const wordBefore = (text: string, index: number) =>
  /([A-Za-z_$][\w$]*)$/u.exec(text.slice(Math.max(0, index - 64), index + 1))?.[1];

function pureJavaScript(code: string): boolean {
  const skeleton = jsSkeleton(code);
  if (!skeleton) return false;
  const { text, strings } = skeleton;
  const forbiddenMember = (name: string) => name.startsWith("_") || JS_FORBIDDEN_MEMBERS.has(name);
  // `.name` and `?.name` are members; `...name` spreads a root value.
  const memberAt = (index: number) => {
    const previous = before(text, index);
    return previous.char === "." && text[previous.index - 1] !== ".";
  };
  for (const match of text.matchAll(/[A-Za-z_$][\w$]*/gu)) {
    const name = match[0];
    const start = match.index;
    const end = start + name.length;
    if (JS_FORBIDDEN_WORDS.has(name)) return false;
    if (memberAt(start)) {
      if (forbiddenMember(name)) return false;
      continue;
    }
    const previous = before(text, start);
    const next = after(text, end);
    // `{ key: …}` / `, key: …` names a property, not a binding.
    if ((previous.char === "{" || previous.char === ",") && next.char === ":") continue;
    if (name === "process") {
      const member = /^\s*\.\s*([A-Za-z_$][\w$]*)/u.exec(text.slice(end, end + 64))?.[1];
      if (!member || !JS_PROCESS.has(member)) return false;
      continue;
    }
    if (JS_KNOWN.has(name) && !JS_ALLOWED.has(name)) return false;
  }
  for (const match of text.matchAll(/\[/gu)) {
    const previous = before(text, match.index);
    const word = wordBefore(text, previous.index);
    const expressionWord =
      !!word && JS_EXPRESSION_AFTER_WORD.has(word) && !memberAt(previous.index - word.length + 1);
    const access =
      [")", "]", "}", '"', "."].includes(previous.char) ||
      (/[\w$]/u.test(previous.char) && !expressionWord);
    if (!access) continue;
    const key = /^\[\s*(?:0|"(\d+)")\s*\]/u.exec(text.slice(match.index, match.index + 32));
    if (!key) return false;
    const literal = key[1] === undefined ? undefined : strings[Number(key[1])];
    if (literal !== undefined && (forbiddenMember(literal) || literal === "process")) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Lua. The standard interpreter's globals are a closed, documented set (5.1–5.4 and LuaJIT); a
// root name outside it is the script's own variable or nil. io and os are allowed only for their
// stdio and clock members.
const LUA_GLOBALS = new Set(
  (
    "_G _VERSION _ENV arg assert bit bit32 collectgarbage coroutine debug dofile error ffi gcinfo " +
    "getfenv getmetatable io ipairs jit load loadfile loadstring math module newproxy next os " +
    "package pairs pcall print rawequal rawget rawlen rawset require select setfenv setmetatable " +
    "string table tonumber tostring type unpack utf8 warn xpcall"
  ).split(" "),
);
const LUA_ALLOWED = new Set(
  (
    "_VERSION arg assert bit32 coroutine error getmetatable ipairs math next pairs pcall print " +
    "rawequal rawget rawlen rawset select setmetatable string table tonumber tostring type unpack " +
    "utf8 xpcall"
  ).split(" "),
);
const LUA_LIMITED: Record<string, ReadonlySet<string>> = {
  io: new Set(["write", "read", "stdout", "stderr", "stdin"]),
  os: new Set(["time", "clock", "date", "difftime", "exit"]),
};
const LUA_KEYWORDS = new Set(
  (
    "and break do else elseif end false for function goto if in local nil not or repeat return " +
    "then true until while"
  ).split(" "),
);

function luaSkeleton(code: string): string | undefined {
  const out: string[] = [];
  let i = code.startsWith("#") ? code.indexOf("\n") + 1 || code.length : 0;
  const longBracket = (at: number) => /^\[(=*)\[/u.exec(code.slice(at, at + 64))?.[1];
  while (i < code.length) {
    const c = code[i] as string;
    if (c === "-" && code[i + 1] === "-") {
      const level = longBracket(i + 2);
      if (level !== undefined) {
        const end = code.indexOf(`]${level}]`, i + 4 + level.length);
        if (end < 0) return undefined;
        i = end + level.length + 2;
      } else while (i < code.length && !/[\n\r]/u.test(code[i] as string)) i++;
      out.push(" ");
      continue;
    }
    if (c === "[") {
      const level = longBracket(i);
      if (level !== undefined) {
        const end = code.indexOf(`]${level}]`, i + 2 + level.length);
        if (end < 0) return undefined;
        i = end + level.length + 2;
        out.push(' "" ');
        continue;
      }
    }
    if (c === "'" || c === '"') {
      i++;
      for (;;) {
        const d = code[i];
        if (d === undefined || d === "\n" || d === "\r") return undefined;
        i++;
        if (d === c) break;
        if (d === "\\") i++;
      }
      out.push(' "" ');
      continue;
    }
    if (c === "\\" || c.charCodeAt(0) > 0x7e) return undefined;
    out.push(c);
    i++;
  }
  return out.join("");
}

function pureLua(code: string): boolean {
  const text = luaSkeleton(code);
  if (text === undefined) return false;
  for (const match of text.matchAll(/[A-Za-z_]\w*/gu)) {
    const name = match[0];
    const start = match.index;
    const end = start + name.length;
    if (/\d/u.test(text[start - 1] ?? "")) continue; // part of a number such as 0x1f or 1e5
    if (LUA_KEYWORDS.has(name)) continue;
    const previous = before(text, start);
    const next = after(text, end);
    const prior = text[previous.index - 1];
    // `t.name` / `t:name()` are members; `a..b` is concatenation and `::label::` a label.
    if ((previous.char === "." && prior !== ".") || (previous.char === ":" && prior !== ":"))
      continue;
    if (previous.char === ":" && prior === ":") continue;
    if (wordBefore(text, previous.index) === "goto") continue;
    // `{ key = …}` / `, key = …` names a field (or an assignment target), not a read.
    if (
      (previous.char === "{" || previous.char === "," || previous.char === ";") &&
      next.char === "=" &&
      text[next.index + 1] !== "="
    )
      continue;
    const limited = LUA_LIMITED[name];
    if (limited) {
      const member = /^\s*\.\s*([A-Za-z_]\w*)/u.exec(text.slice(end, end + 64))?.[1];
      if (!member || !limited.has(member)) return false;
      continue;
    }
    if (LUA_GLOBALS.has(name) && !LUA_ALLOWED.has(name)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// PHP. Every call by name must be an allowlisted built-in without callbacks (a callback can be a
// string naming any function), a language construct, or a function the file declares at the top
// level (a top-level declaration that collides with a built-in is a compile error, so it can never
// stand in for one). Dynamic calls, `new`, static calls, includes and superglobals are refused.
const PHP_FUNCTIONS = new Set(
  (
    "abs array_chunk array_column array_combine array_count_values array_fill array_flip " +
    "array_key_exists array_key_first array_key_last array_keys array_merge array_pad array_pop " +
    "array_product array_push array_reverse array_search array_shift array_slice array_sum " +
    "array_unique array_unshift array_values arsort asort base64_decode base64_encode bin2hex " +
    "bindec boolval ceil checkdate chr count crc32 date decbin dechex explode feof fgets " +
    "floatval floor fmod fputs fread fwrite gettype hash hex2bin hexdec htmlspecialchars " +
    "implode in_array intdiv intval is_array is_bool is_float is_int is_null is_numeric " +
    "is_string join krsort ksort lcfirst levenshtein ltrim max mb_strlen mb_strtolower " +
    "mb_strtoupper mb_substr md5 microtime min mktime mt_rand nl2br number_format ord pow " +
    "preg_match preg_match_all preg_quote preg_split print_r printf rand random_int range round " +
    "rsort rtrim sha1 similar_text sizeof sort sprintf sqrt str_contains str_ends_with str_pad " +
    "str_repeat str_split str_starts_with str_word_count stream_get_contents strlen strpos " +
    "strrev strrpos strtolower strtoupper strval substr time trim ucfirst ucwords var_dump " +
    "var_export wordwrap stripos str_replace str_ireplace json_encode json_decode"
  ).split(" "),
);
const PHP_CONSTRUCTS = new Set(
  (
    "if elseif while for foreach switch match catch array list isset empty unset function fn " +
    "return echo print exit die and or xor declare use static"
  ).split(" "),
);
const PHP_FORBIDDEN_WORDS = new Set(
  (
    "include include_once require require_once eval new clone class interface trait enum " +
    "namespace goto extends implements insteadof abstract final __halt_compiler"
  ).split(" "),
);

function phpSkeleton(raw: string): string | undefined {
  let code = raw.startsWith("#!") ? raw.slice(raw.indexOf("\n") + 1 || raw.length) : raw;
  code = code.replace(/^\s*<\?php\b/u, "").replace(/\?>\s*$/u, "");
  // A `?>` ends PHP mode even inside a `//` comment; text after it could open PHP again.
  if (/<\?|\?>|<<<|`|#\[/u.test(code)) return undefined;
  const out: string[] = [];
  let i = 0;
  while (i < code.length) {
    const c = code[i] as string;
    if ((c === "/" && code[i + 1] === "/") || c === "#") {
      while (i < code.length && !/[\n\r]/u.test(code[i] as string)) i++;
      continue;
    }
    if (c === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      if (end < 0) return undefined;
      i = end + 2;
      out.push(" ");
      continue;
    }
    if (c === "'" || c === '"') {
      let text = "";
      i++;
      for (;;) {
        const d = code[i];
        if (d === undefined) return undefined;
        i++;
        if (d === c) break;
        if (d === "\\") {
          text += code[i] ?? "";
          i++;
          continue;
        }
        text += d;
      }
      // Interpolated expressions (`{$a->b()}`, `${…}`) run code inside a string.
      if (c === '"' && /\{\$|\$\{/u.test(text)) return undefined;
      out.push(" '' ");
      continue;
    }
    if (c === "\\" || c.charCodeAt(0) > 0x7e) return undefined;
    out.push(c);
    i++;
  }
  return out.join("");
}

function purePhp(code: string): boolean {
  const text = phpSkeleton(code);
  if (text === undefined) return false;
  // Calls through a value (`$f()`, `'system'()`, `$a['f']()`, `(…)()`), static calls, variable
  // variables and dynamic property names.
  if (/::|\$\$|\$\{|->\s*\$|\$\w*\s*\(|['\])}]\s*\(/u.test(text)) return false;
  if (/\$(?:_\w*|GLOBALS)\b/u.test(text)) return false;
  const declared = new Set<string>();
  let depth = 0;
  const depthAt: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") depth--;
    depthAt[i] = depth;
  }
  for (const match of text.matchAll(/\bfunction\s*&?\s*([A-Za-z_]\w*)\s*\(/giu)) {
    // Only an unconditional top-level declaration is known at compile time (see above).
    if ((depthAt[match.index] ?? 0) !== 0) return false;
    declared.add((match[1] as string).toLowerCase());
  }
  for (const match of text.matchAll(/[A-Za-z_]\w*/gu)) {
    const name = match[0].toLowerCase();
    const start = match.index;
    const end = start + name.length;
    if (/[\w$]/u.test(text[start - 1] ?? "")) continue; // a variable ($x) or part of a number
    if (PHP_FORBIDDEN_WORDS.has(name)) return false;
    const previous = before(text, start);
    if (previous.char === ">" && text[previous.index - 1] === "-") continue; // ->method / ->prop
    if (wordBefore(text, previous.index)?.toLowerCase() === "function") continue;
    const next = after(text, end);
    if (name === "use" && !(next.char === "(" && previous.char === ")")) return false;
    if (next.char !== "(") continue; // a constant, keyword or named argument
    if (!PHP_FUNCTIONS.has(name) && !PHP_CONSTRUCTS.has(name) && !declared.has(name)) return false;
  }
  return true;
}
