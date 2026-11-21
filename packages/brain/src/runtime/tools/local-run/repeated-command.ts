import { type LocalToolResult, toolEffectClass } from "@pibot/agent";
import { searchKind } from "@pibot/tools/command";
import type { PreparedTool } from "../../../core/local-types.ts";
import { isCommandCall } from "./local-run-shared.ts";

/** The 2nd identical answer is still useful (it proves stability); the 3rd only repeats it. */
export const REPEAT_LIMIT = 2;
/** One run is one turn, but a stuck model can vary the command text; keep the cache bounded. */
const MAX_ENTRIES = 32;

export interface RepeatedCommand {
  text: string;
  count: number;
  result: LocalToolResult;
}

/**
 * Identify a repeated command by normalized text plus cwd, so a different folder or a
 * reworded query is a different question.
 *
 * Only a **search** qualifies. A search answer is "these matches" or "none", and the same command
 * in the same folder with the same files can only produce the same answer; skipping it hides
 * nothing. Everything else must run: `cat log` / `ls out/` in a polling loop exist to observe new
 * output, and a write must always happen. Rerunning a search is cheap; showing the model a stale
 * answer is not.
 */
export function repeatedCommandKey(prepared: PreparedTool): string | undefined {
  if (prepared.call.tool !== "run_command") return;
  const analysis = prepared.result.analysis;
  if (analysis?.readonly !== true || analysis.incomplete || analysis.writes.length) return;
  // Same program list as the "no matches" rule, so the two halves of this task cannot drift.
  if (!searchKind(analysis)) return;
  const input = prepared.call.input as {
    command?: unknown;
    background?: unknown;
    docker?: unknown;
    outsideSandbox?: unknown;
  };
  if (input.background || input.docker || input.outsideSandbox) return;
  if (typeof input.command !== "string") return;
  const command = input.command.trim().replace(/\s+/g, " ");
  if (!command) return;
  return `${prepared.cwd}\u0000${command}`;
}

/** Same answer again: replaying it is cheaper than proving the same thing a third time. */
export function repeatAnswer(cached: RepeatedCommand): LocalToolResult {
  return {
    ...cached.result,
    text: `${cached.result.text}\n和上次结果相同，请换个查法或继续下一步 / Same result as last time; change the approach or continue.`,
  };
}

/**
 * A changed answer is new information, so the count restarts instead of skipping a real result.
 */
export function rememberRepeatedCommand(
  cache: Map<string, RepeatedCommand>,
  key: string,
  result: LocalToolResult,
): void {
  const previous = cache.get(key);
  const count = previous && previous.text === result.text ? previous.count + 1 : 1;
  // Re-insert so the first key stays the least recently seen command.
  cache.delete(key);
  cache.set(key, { text: result.text, count, result });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) return;
    cache.delete(oldest);
  }
}

/**
 * A cached answer is only true while the files it describes are unchanged, so a step that may write
 * voids the whole cache — and it is the step, not the tool name, that decides: `toolEffectClass`
 * already classifies every built-in call, and the command analysis already proves read-only
 * commands. Dropping the cache costs one rerun; keeping a stale one makes the model reason about
 * a file that no longer looks like that.
 *
 * A background command counts as a write even when its call returns: it keeps writing after the
 * answer, so the next identical search cannot be assumed unchanged either.
 */
export function stepChangesFiles(prepared: PreparedTool): boolean {
  const { tool, input } = prepared.call;
  if (!isCommandCall(tool)) return toolEffectClass(tool, input) !== "read";
  if ((input as { background?: unknown }).background === true) return true;
  const analysis = prepared.result.analysis;
  return analysis?.readonly !== true || analysis.incomplete === true || analysis.writes.length > 0;
}
