import { posix } from "node:path";
import type { Node } from "web-tree-sitter";
import type { AnalysisBudget } from "./analysis-budget.ts";

export interface DirectoryState {
  paths: readonly string[];
  unknown: boolean;
}
export const initialDirectory: DirectoryState = { paths: ["."], unknown: false };
const unknown: DirectoryState = { paths: [], unknown: true };

// Bound branch growth; an unknown directory must never become the initial cwd again.
function merge(...states: DirectoryState[]): DirectoryState {
  const paths = [...new Set(states.flatMap((state) => state.paths))];
  return paths.length > 16 ? unknown : { paths, unknown: states.some((state) => state.unknown) };
}
export function directoryPath(directory: string, path: string) {
  // Keep .. components until policy's component-by-component canonical path check.
  return posix.isAbsolute(path) || path.startsWith("~") || directory === "."
    ? path
    : `${directory}/${path}`;
}

/** Path facts at each node, including both outcomes of a failed `cd; write`. */
export function directoryFlow(
  root: Node,
  literal: (text: string) => string | undefined,
  budget: AnalysisBudget,
  initial = initialDirectory,
) {
  const contexts = new Map<number, DirectoryState>();
  const changes = new Map<number, string | undefined>();
  type Outcomes = { success: DirectoryState; failure: DirectoryState };
  const mark = (node: Node, state: DirectoryState) => {
    const pending = [node];
    while (pending.length && budget.check()) {
      const current = pending.pop();
      if (!current) break;
      contexts.set(current.id, state);
      pending.push(...current.namedChildren);
    }
  };
  const visit = (node: Node, state: DirectoryState, depth = 0): Outcomes => {
    if (!budget.check() || depth > 128) {
      mark(node, unknown);
      return { success: unknown, failure: unknown };
    }
    contexts.set(node.id, state);
    const children = node.namedChildren.filter((child) => child.type !== "comment");
    if (node.type === "program") {
      let current = state;
      for (const child of children) {
        const outcome = visit(child, current, depth + 1);
        current = merge(outcome.success, outcome.failure);
      }
      return { success: current, failure: current };
    }
    if (node.type === "list" && children.length === 2) {
      const operator = node.children.find((child) => !child.isNamed)?.text;
      const left = children[0];
      const right = children[1];
      if (left && right && (operator === "&&" || operator === "||")) {
        const first = visit(left, state, depth + 1);
        const next = visit(right, operator === "&&" ? first.success : first.failure, depth + 1);
        return operator === "&&"
          ? { success: next.success, failure: merge(first.failure, next.failure) }
          : { success: merge(first.success, next.success), failure: next.failure };
      }
    }
    if (node.type === "command") {
      mark(node, state);
      const words = children.map((child) => literal(child.text));
      for (const child of children)
        if (/substitution/.test(child.type) && /\b(?:cd|pushd|popd)\b/.test(child.text))
          mark(child, unknown);
      if (["cd", "pushd", "popd"].includes(words[0] ?? "")) {
        let args = words.slice(1);
        if (args[0] === "--" || args[0] === "-L") args = args.slice(1);
        const target = args.length === 1 ? args[0] : undefined;
        // Logical cd through .. may differ from the physical path below a symlink.
        const validated =
          words[0] !== "popd" &&
          target &&
          !target.startsWith("-") &&
          !target.includes("~") &&
          !target.split("/").includes("..")
            ? target
            : undefined;
        changes.set(node.id, validated);
        const success =
          validated !== undefined
            ? {
                paths: posix.isAbsolute(validated)
                  ? [validated]
                  : state.paths.map((path) => directoryPath(path, validated)),
                unknown: !posix.isAbsolute(validated) && state.unknown,
              }
            : unknown;
        return { success, failure: state };
      }
      // Eval/source can mutate this shell; wrapped builtins are not straight-line cwd proof.
      if (["eval", "source", ".", "command", "builtin"].includes(words[0] ?? ""))
        return { success: unknown, failure: merge(state, unknown) };
      return { success: state, failure: state };
    }
    if (node.type === "redirected_statement") {
      const body = node.childForFieldName("body");
      if (body) {
        const outcome = visit(body, state, depth + 1);
        // tree-sitter-bash wraps `cd dir && echo > file` around the whole list; the redirect
        // belongs to the final command, and opens before that command changes its own cwd.
        let terminal = body;
        while (terminal.type === "list" && budget.check()) {
          const last = terminal.namedChildren.at(-1);
          if (!last) break;
          terminal = last;
        }
        const beforeLast = contexts.get(terminal.id) ?? unknown;
        for (const child of children) if (child.id !== body.id) mark(child, beforeLast);
        return outcome;
      }
    }
    // Shell scopes, loops, functions and substitutions are not a straight-line proof. Preserve
    // literal absolute paths, but don't anchor relative paths at a guessed initial directory.
    const hasChange = /\b(?:cd|pushd|popd)\b/.test(node.text);
    const fallback = hasChange ? unknown : state;
    mark(node, fallback);
    return { success: fallback, failure: fallback };
  };
  visit(root, initial);
  return { contexts, changes };
}
