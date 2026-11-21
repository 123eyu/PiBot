// Plain assignments and positional parameters are put
// into a script's text before it is analysed, so `cat "$TOKEN_FILE"` is judged as the file it
// names. Values come only from the bash parse, never from text lines: a line that merely looks
// like `NAME=value` inside a quoted string, after a `\` continuation or inside `if false` is not
// an assignment, and treating it as one let `"$BASH" b.sh` be judged as `cat b.sh`.
import type { Node } from "web-tree-sitter";
import { wrapperOptions } from "./options/wrapper-options.ts";

/**
 * Names whose value the shell itself, the interpreters it starts or the programs it runs read
 * (directly or because execution exports them): an assignment to one changes more than the
 * words it is expanded into, so it is never substituted and stays visible to the analyser.
 */
const SPECIAL =
  /^(?:_|BASH\w*|SHELL\w*|PATH|IFS|HOME|PWD|OLDPWD|ENV|CDPATH|FPATH|PS\d|PROMPT\w*|RPROMPT\w*|RPS\d|SHELLOPTS|BASHOPTS|GLOBIGNORE|POSIXLY_CORRECT|ZDOTDIR|KSH_\w+|HIST\w*|MAIL\w*|FCEDIT|TMPDIR|TERM\w*|LANG|LANGUAGE|LC_\w+|USER|LOGNAME|XDG_\w+|GIT_\w+|LD_\w+|DYLD_\w+|PYTHON\w*|VIRTUAL_ENV|CONDA\w*|PIP_\w+|UV_\w+|NODE_\w+|NPM_\w+|PERL\w*|RUBY\w*|GEM_\w+|BUNDLE_\w+|LUA_\w+|OPTIND|OPTARG|OPTERR|REPLY|RANDOM|SRANDOM|SECONDS|LINENO|UID|EUID|PPID|HOSTNAME|HOSTTYPE|OSTYPE|MACHTYPE|EPOCH\w+|COLUMNS|LINES|FUNCNAME|PIPESTATUS|GROUPS|DIRSTACK|TIMEFORMAT|COMP_\w+|argv|path|fpath|cdpath|manpath|module_path|mailpath|psvar|fignore|prompt|status|pipestatus|options|parameters|commands|functions|aliases|builtins)$/u;
const PLAIN = /^[\w./@:%+-]*$/u;
const BRACED = /^\$\{(\d+|[A-Za-z_][A-Za-z0-9_]*)(?::-([^}$`]*))?\}$/u;
const SIMPLE = /^\$(\d|[A-Za-z_][A-Za-z0-9_]*)$/u;
// `set` options that leave the positional parameters alone; anything else (`set -- a b`,
// `set a b`) replaces them, as does `shift`.
const SET_OPTION = /^[-+][a-zA-Z]+$/u;

interface Assignment {
  name: string;
  /** Where the assignment's own name token starts: not a "use" of the name. */
  nameIndex: number;
  start: number;
  end: number;
  value?: Node;
}

/** Text edits on `text`: [start, end) replaced, applied back to front. */
type Edit = { start: number; end: number; text: string };

/**
 * N4: a script that changes the shell's own environment (PATH, IFS, BASH_ENV, …) through an
 * assigning builtin, or names a variable in one with quotes or escapes (`export P"ATH"=./bin`,
 * `declare I\FS=@`), can make the commands it runs differ from the text policy reads — another
 * `cat` on PATH, one word split into two paths. Such a script is uncertain, whatever else it does.
 */
export function changesShellEnvironment(root: Node): boolean {
  const pending = [root];
  while (pending.length) {
    const node = pending.pop() as Node;
    pending.push(...node.namedChildren);
    if (node.type === "variable_assignment") {
      const name = node.childForFieldName("name")?.text ?? "";
      if (SPECIAL.test(name) || /["'\\$]/u.test(name)) return true;
      continue;
    }
    if (!COMMANDS.has(node.type)) continue;
    const tokens = rawTokens(node.text);
    let at = 0;
    while (tokens[at] === "command" || tokens[at] === "builtin") {
      at++;
      while (tokens[at]?.startsWith("-")) at++;
    }
    const program = tokens[at] ?? "";
    if (!ASSIGNING.has(program) && program !== "printf") continue;
    const args = tokens.slice(at + 1);
    const names =
      program === "printf"
        ? args.flatMap((arg, i) => (args[i - 1] === "-v" ? [arg] : []))
        : args.filter((arg) => !/^[-+]/u.test(arg));
    for (const raw of names) {
      const name = nameOf(raw);
      if (/["'\\$`]/u.test(name)) return true;
      if (SPECIAL.test(name)) return true;
    }
  }
  return false;
}
/** The name part of `NAME=value` as written: up to the first `=` outside quotes. */
function nameOf(raw: string) {
  let quote: string | undefined;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      if (c === quote) quote = undefined;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "\\") i++;
    else if (c === "=") return raw.slice(0, i);
  }
  return raw;
}
/** Shell words as written (quotes and escapes kept), split on unquoted blanks. */
function rawTokens(text: string) {
  const tokens: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quote) {
      current += c;
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === '"') current += text[++i] ?? "";
    } else if (c === "'" || c === '"') {
      quote = c;
      current += c;
    } else if (c === "\\") current += c + (text[++i] ?? "");
    else if (/\s/u.test(c)) {
      if (current) tokens.push(current);
      current = "";
    } else current += c;
  }
  if (current) tokens.push(current);
  return tokens;
}

export function substituteShell(
  root: Node,
  text: string,
  args: readonly string[],
  literal: (text: string) => string | undefined,
): string {
  const leading = leadingAssignments(root);
  const used = new Set(leading.map((entry) => entry.name));
  const { all, changed } = scriptChanges(root, text, used, leading, literal);
  // Something could reassign names unseen: leave every expansion as written (dynamic).
  if (all) return text;
  const positional = positionalStable(root, literal);
  /**
   * name → its leading assignments in source order. A value that could not be read ends what
   * is known about the name from there on (`value` undefined), so later uses stay dynamic.
   */
  const known = new Map<string, { end: number; value?: string }[]>();
  const edits: Edit[] = [];
  const valueAt = (name: string, at: number) => {
    if (/^\d+$/u.test(name)) {
      const index = Number(name);
      return positional && index >= 1
        ? { set: index <= args.length, value: args[index - 1] }
        : undefined;
    }
    const entries = known.get(name);
    const entry = entries?.filter((candidate) => candidate.end <= at).at(-1);
    return entry?.value !== undefined ? { set: true, value: entry.value } : undefined;
  };
  // Expansions inside one node (a whole assignment value, or the whole script).
  const expand = (node: Node, skip: (inner: Node) => boolean) => {
    const local: Edit[] = [];
    const pending = [node];
    while (pending.length) {
      const current = pending.pop() as Node;
      if (skip(current)) continue;
      if (current.type === "simple_expansion" || current.type === "expansion") {
        const replaced = replacement(current, valueAt, literal);
        if (replaced !== undefined)
          local.push({ start: current.startIndex, end: current.endIndex, text: replaced });
        continue;
      }
      pending.push(...current.namedChildren);
    }
    return local;
  };
  const removed = new Set<number>();
  for (const entry of leading) {
    if (SPECIAL.test(entry.name) || changed.has(entry.name)) continue;
    let value: string | undefined = "";
    if (entry.value) {
      const local = expand(entry.value, () => false);
      const raw = apply(text, local, entry.value.startIndex, entry.value.endIndex);
      // `NAME=~/x` expands the tilde at run time; the analyser would read it as a literal name.
      value = raw.includes("~") ? undefined : literal(raw);
    }
    const list = known.get(entry.name) ?? [];
    list.push({ end: entry.end, ...(value !== undefined ? { value } : {}) });
    known.set(entry.name, list);
    // A value that still expands something (or is not plain shell text) is not substituted;
    // the assignment stays in the text, which the analyser treats as dynamic shell content.
    if (value === undefined) continue;
    removed.add(entry.start);
    edits.push({ start: entry.start, end: removalEnd(text, entry.end), text: "" });
  }
  // Values only replace uses after their assignment, outside functions (other positional
  // parameters), never in program position (also after a wrapper: N1), and never inside an
  // assignment that was removed.
  edits.push(
    ...expand(
      root,
      (node) =>
        node.type === "function_definition" ||
        node.type === "command_name" ||
        runsProgram(node, literal) ||
        (node.type === "variable_assignment" && removed.has(node.startIndex)),
    ),
  );
  return apply(text, edits, 0, text.length);
}

/**
 * Top-level `NAME=value` statements that come before any compound command, list, pipeline,
 * redirect or function definition: they run once, in order, before everything after them.
 */
function leadingAssignments(root: Node): Assignment[] {
  const found: Assignment[] = [];
  for (const child of root.namedChildren) {
    if (child.type === "comment" || child.type === "command") continue;
    if (child.type !== "variable_assignment") break;
    const name = child.childForFieldName("name");
    // `NAME+=value` appends to a value that may come from the environment.
    if (!name || !child.text.slice(name.text.length).startsWith("=")) break;
    found.push({
      name: name.text,
      nameIndex: name.startIndex,
      start: child.startIndex,
      end: child.endIndex,
      value: child.childForFieldName("value") ?? undefined,
    });
  }
  return found;
}

/** Builtins that assign variables named by their words (`export P"X"=…`, `read X`). */
const ASSIGNING = new Set([
  "export",
  "declare",
  "typeset",
  "readonly",
  "local",
  "unset",
  "read",
  "getopts",
  "mapfile",
  "readarray",
  "let",
]);
/** Builtins that run text or definitions not parsed here (sh expands aliases in scripts). */
const RUNS_TEXT = new Set(["eval", "trap", "source", ".", "alias", "enable"]);

/**
 * A command's shell words as bash forms them: tree-sitter splits `P"X"=bash` after `export` into
 * two nodes, so children that touch (no blank between them) are one word, decoded together.
 */
function shellWords(node: Node, literal: (text: string) => string | undefined, assignments = true) {
  const groups: string[] = [];
  let end = -1;
  for (const child of node.namedChildren) {
    if (child.type.endsWith("redirect") || child.type === "comment") continue;
    // `X=1 cmd`: the prefix is not the program word.
    if (!assignments && node.type === "command" && child.type === "variable_assignment") continue;
    if (child.startIndex === end && groups.length) groups[groups.length - 1] += child.text;
    else groups.push(child.text);
    end = child.endIndex;
  }
  // A declaration or `unset` keyword is an unnamed child: it is the program word.
  const keyword =
    node.type === "declaration_command" || node.type === "unset_command"
      ? node.child(0)?.text
      : undefined;
  return [...(keyword ? [keyword] : []), ...groups].map((word) => literal(word));
}
const COMMANDS = new Set(["command", "declaration_command", "unset_command"]);

/**
 * Names something other than a leading assignment could give another value, and whether the
 * script could reassign names this cannot see at all (`all`).
 *
 * Security review N1: the raw text alone misses names spelled with quotes (`export P"X"=bash`,
 * `printf -v P"X" %s bash`), which bash reassigns after quote removal. So every command's words
 * are also decoded as bash forms them; any decoded word that mentions the name bare counts.
 * A dynamic program word, an assigning builtin with a word that cannot be decoded, a nameref
 * (`declare -n`), arithmetic (`(( P"X"=1 ))` removes quotes too) or an array subscript means
 * nothing is substituted.
 */
function scriptChanges(
  root: Node,
  text: string,
  names: ReadonlySet<string>,
  leading: readonly Assignment[],
  literal: (text: string) => string | undefined,
) {
  const changed = new Set<string>();
  const bare = new Map(
    [...names].map((name) => [name, new RegExp(`(?<![\\w$]|\\$\\{)${name}(?!\\w)`, "gu")]),
  );
  const own = new Set(leading.map((entry) => entry.nameIndex));
  for (const [name, pattern] of bare) {
    for (const match of text.matchAll(pattern))
      if (!own.has(match.index)) {
        changed.add(name);
        break;
      }
    if (new RegExp(`\\$\\{${name}(?!\\}|:-)`, "u").test(text)) changed.add(name);
  }
  if (text.includes("((")) return { all: true, changed };
  const pending = [root];
  while (pending.length) {
    const node = pending.pop() as Node;
    pending.push(...node.namedChildren);
    if (node.type === "subscript" || node.type === "arithmetic_expansion")
      return { all: true, changed };
    if (!COMMANDS.has(node.type)) continue;
    const words = shellWords(node, literal);
    // The builtin that runs, past `command` / `builtin` and their options.
    const command = shellWords(node, literal, false);
    let at = 0;
    while (command[at] === "command" || command[at] === "builtin") {
      at++;
      while (command[at]?.startsWith("-")) at++;
    }
    const program = command[at];
    // A dynamic program word could itself be `export` or `eval`.
    if (at < command.length && program === undefined) return { all: true, changed };
    if (program !== undefined && RUNS_TEXT.has(program)) return { all: true, changed };
    // `printf -v NAME` assigns; a dynamic first argument could be that `-v`.
    const first = command[at + 1];
    const assigning =
      program !== undefined &&
      (ASSIGNING.has(program) ||
        (program === "printf" && at + 1 < command.length && (first ?? "-").startsWith("-")));
    if (assigning && command.some((word) => word === undefined)) return { all: true, changed };
    if (assigning && command.slice(at + 1).some((word) => /^[-+][A-Za-z]*n/u.test(word ?? "")))
      return { all: true, changed };
    for (const word of words)
      for (const [name, pattern] of bare)
        if (word !== undefined && new RegExp(pattern.source, "u").test(word)) changed.add(name);
  }
  return { all: false, changed };
}

/**
 * Programs that run another program named by one of their words (`command "$P" b.sh`,
 * `timeout 5 "$P"`, `env "$P"`, `find -exec "$P"`): a substituted word there would be a program
 * position the analyser cannot tell apart from an argument, so their words stay as written.
 */
const RUNS_PROGRAMS = new Set([
  ...Object.keys(wrapperOptions),
  "command",
  "builtin",
  "exec",
  "eval",
  "source",
  ".",
  "trap",
  "nohup",
  "setsid",
  "disown",
  "time",
  "nice",
  "ionice",
  "chrt",
  "taskset",
  "timeout",
  "gtimeout",
  "stdbuf",
  "env",
  "xargs",
  "parallel",
  "find",
  "flock",
  "watch",
  "caffeinate",
  "unbuffer",
  "script",
  "chroot",
  "sudo",
  "doas",
  "su",
  "busybox",
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
]);
function runsProgram(node: Node, literal: (text: string) => string | undefined) {
  if (node.type !== "command") return false;
  const program = shellWords(node, literal, false)[0];
  return program === undefined || RUNS_PROGRAMS.has(program.split("/").at(-1) ?? program);
}

/** Whether `$1`… keep the script's arguments throughout (no `shift`, no `set -- …`). */
function positionalStable(root: Node, literal: (text: string) => string | undefined) {
  const pending = [root];
  while (pending.length) {
    const node = pending.pop() as Node;
    if (node.type === "command") {
      const all = shellWords(node, literal, false);
      // `command set -- x` / `builtin shift` reach the same builtins; text run by eval, trap or
      // source could contain either.
      const start = all.findIndex((word) => word !== "command" && word !== "builtin");
      const words = start < 0 ? [] : all.slice(start);
      const program = words[0];
      if (start < 0 || program === undefined || program === "shift") return false;
      if (["eval", "trap", "source", "."].includes(program)) return false;
      if (program === "set") {
        for (let i = 1; i < words.length; i++) {
          const word = words[i];
          if (word === "-o" || word === "+o") i++;
          else if (word === undefined || !SET_OPTION.test(word)) return false;
        }
      }
    }
    pending.push(...node.namedChildren);
  }
  return true;
}

function replacement(
  node: Node,
  valueAt: (name: string, at: number) => { set: boolean; value: string | undefined } | undefined,
  literal: (text: string) => string | undefined,
): string | undefined {
  const braced = BRACED.exec(node.text);
  const simple = braced ? undefined : SIMPLE.exec(node.text);
  const name = braced?.[1] ?? simple?.[1];
  if (!name) return undefined;
  const known = valueAt(name, node.startIndex);
  if (!known) return undefined;
  let value = known.set ? known.value : undefined;
  const fallback = braced?.[2];
  if (fallback !== undefined && !value) {
    // `${1:-downloads}`: the default applies to an unset or empty value; it must be plain text.
    value = literal(fallback);
    if (value === undefined) return undefined;
  }
  if (value === undefined) return undefined;
  if (insideDoubleQuotes(node)) return value.replace(/["\\$`]/gu, "\\$&");
  // Unquoted, the shell splits and globs the value: only a plain word means the same either way.
  return PLAIN.test(value) && value !== "" ? value : undefined;
}

function insideDoubleQuotes(node: Node) {
  let parent = node.parent;
  while (parent?.type === "concatenation") parent = parent.parent;
  return parent?.type === "string";
}

/** Also drops a `;` that ended the removed assignment, so `X=1; cmd` stays valid shell. */
function removalEnd(text: string, end: number) {
  const match = /^[ \t]*;(?!;)/u.exec(text.slice(end));
  return match ? end + match[0].length : end;
}

function apply(text: string, edits: readonly Edit[], start: number, end: number) {
  const inside = edits
    .filter((edit) => edit.start >= start && edit.end <= end)
    .toSorted((a, b) => b.start - a.start);
  let result = text.slice(start, end);
  let limit = Number.POSITIVE_INFINITY;
  for (const edit of inside) {
    // Overlapping edits cannot happen for distinct nodes; skip defensively rather than corrupt.
    if (edit.end > limit) continue;
    result = result.slice(0, edit.start - start) + edit.text + result.slice(edit.end - start);
    limit = edit.start;
  }
  return result;
}
