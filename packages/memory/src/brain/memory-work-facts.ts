/**
 * Maintainers 2026-11-11: user-scope memory is shared with every Bot, yet development Bots filled it
 * with repository paths, commands and task ids. The model-side rules are the main fix; this is the
 * cheap program check behind them. It only fires on markers that do not occur in a note about the
 * person themself (a path, a CLI invocation, a commit hash, a task id, an address), so a plain
 * preference such as "写周报先给结论" or "prefers short answers" never matches. Anything subtler is
 * left to the model, never guessed here.
 */
const WORK_FACT_SIGNALS: readonly RegExp[] = [
  // Absolute or home-relative paths with at least two segments: /Users/x/repo, ~/code/app, ./src/a
  /(?:^|[^\w/])(?:~|\.{1,2})?\/[\w.-]+\/[\w./-]+/u,
  // Relative paths to a source file. A bare file name is not enough: "示例统一用 example.ts" is a
  // way the person wants things done, not where some project lives.
  /\b[\w.-]+(?:\/[\w.-]+)+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|swift|sh|ps1|sql|toml|ya?ml|lock)\b/u,
  // Package names such as @scope/pkg.
  /(?:^|\s)@[a-z][\w-]*\/[\w.-]+/u,
  // CLI invocations with a real subcommand: "pnpm 而不是 npm" or "uses git for" stay unmatched.
  /\b(?:pnpm|npm|yarn)\s+(?:run|install|i|add|exec|test|build|dev|lint|typecheck|verify|check|format|dlx|publish)\b/u,
  /\b(?:pnpm|npm|yarn)\s+(?:run\s+)?[a-z][\w-]*:[\w:-]+/u,
  /\bgit\s+(?:commit|push|pull|merge|rebase|checkout|switch|clone|log|diff|status|stash|worktree|branch|tag|fetch|reset|cherry-pick)\b/u,
  /\bgh\s+(?:pr|issue|api|repo|release|run)\b/u,
  /\b(?:docker|podman)\s+(?:run|compose|build|exec|ps|pull|push)\b/u,
  /\b(?:kubectl|cargo|uv|pip|brew)\s+(?:apply|get|build|run|test|install|sync|add|pip)\b/u,
  /\bssh\s+(?:-\w+\s+)*[\w.-]+@[\w.-]+/u,
  /\bnode\s+[\w./-]+\.(?:ts|js|mjs|cjs)\b/u,
  // Commit hashes: 7–40 hex characters with both a digit and a letter.
  /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/u,
  // Task and ticket ids: XY12-T3, PR #123.
  /\b[A-Z]{1,4}\d{1,3}-T\d+\b/u,
  /\b(?:PR|MR|issue)\s*#\d+\b/iu,
  // Hosts and ports.
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/u,
  /\blocalhost:\d+\b/u,
  // Environment assignments and long CLI flags.
  /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+=/u,
  /(?:^|\s)--[a-z][\w-]{2,}\b/u,
  // Inline code alone is not a signal: "用户偏好用 `中文` 交流" is about the person. A code span
  // that holds a path or command is already caught by the patterns above.
];

/**
 * Wording that states a preference meant for every Bot. Such a note stays shared whatever paths or
 * commands it mentions: the person chose its reach, the markers only describe its subject.
 */
const USER_WIDE: readonly RegExp[] = [
  /(?:所有|每个|全部|任何|各个)\s*(?:的\s*)?(?:Bot|bot|助手|机器人)/u,
  /以后都|今后都|一律|始终|总是|永远|一直都/u,
  /(?:我|用户)(?:都)?(?:希望|喜欢|偏好|习惯|倾向|想要|要求|不喜欢|讨厌)/u,
  /\b(?:always|never|from now on|for all bots|every bot|all bots|any bot)\b/iu,
  /\b(?:I|the user|user)\s+(?:prefers?|likes?|wants?|dislikes?|hates?|expects?)\b/iu,
];

export function looksLikeWorkFact(text: string): boolean {
  if (USER_WIDE.some((marker) => marker.test(text))) return false;
  return WORK_FACT_SIGNALS.some((signal) => signal.test(text));
}
