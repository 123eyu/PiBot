import type { AgentRuntime } from "@pibot/agent";
import { abortable, resolvePersonaLanguage } from "@pibot/brain/kit";
import type { Logger } from "@pibot/observability";
import type { Redactor } from "@pibot/secrets";
import { BotsRepo, SettingsRepo } from "@pibot/storage";
import { type ChangesScope, changesError } from "../changes-scope.ts";
import type { ChangesService } from "../changes-service.ts";
import { uncommittedDiff } from "../review/changes-diff.ts";

/** Only a bounded excerpt of the selected diff leaves the machine. */
const DIFFED_FILES = 12;
const LINES_PER_FILE = 80;
const LISTED_FILES = 200;
const SUMMARY_CHARS = 16_000;

export interface CommitDrafterDeps {
  agent: AgentRuntime;
  db: ConstructorParameters<typeof BotsRepo>[0];
  redactor: Redactor;
  logger: Logger;
  requireCredentials(provider: string): Promise<void>;
}

/** Diff text is redacted and trimmed before the model sees it; generated and binary files list names only. */
async function summary(
  service: ChangesService,
  scope: ChangesScope,
  paths: string[],
  redactor: Redactor,
  signal: AbortSignal,
) {
  const out: string[] = [];
  let size = 0;
  const push = (line: string) => {
    if (size >= SUMMARY_CHARS) return false;
    const safe = redactor.redact(line).slice(0, 400);
    out.push(safe);
    size += safe.length + 1;
    return true;
  };
  const known = service.remembered(scope.root.path);
  push(`Files (${paths.length}):`);
  for (const path of paths.slice(0, LISTED_FILES))
    push(`- ${path} [${known?.get(path)?.status ?? "changed"}]`);
  if (paths.length > LISTED_FILES) push(`- … ${paths.length - LISTED_FILES} more`);
  let diffed = 0;
  for (const path of paths) {
    if (diffed >= DIFFED_FILES || size >= SUMMARY_CHARS) break;
    if (/(^|\/)(node_modules|dist|build|vendor)\//.test(path) || /lock(\.\w+)?$/.test(path))
      continue;
    const diff = await uncommittedDiff(service, scope, path, signal).catch(() => undefined);
    signal.throwIfAborted();
    if (!diff || diff.binary || diff.tooLarge || !diff.hunks.length) continue;
    diffed++;
    push("");
    push(`diff ${path} (+${diff.added ?? 0} -${diff.removed ?? 0})`);
    let lines = 0;
    for (const hunk of diff.hunks) {
      if (lines >= LINES_PER_FILE) break;
      for (const line of hunk.lines) {
        if (lines >= LINES_PER_FILE) break;
        if (!line.startsWith("+") && !line.startsWith("-")) continue;
        lines++;
        if (!push(line)) break;
      }
    }
  }
  return out.join("\n");
}

/** Uses the conversation Bot's own text model, falling back to the default model. */
export function createCommitDrafter(deps: CommitDrafterDeps) {
  const draft = deps.agent.draftCommitMessage?.bind(deps.agent);
  if (!draft) return undefined;
  return (service: ChangesService) =>
    async (scope: ChangesScope, paths: string[], signal: AbortSignal) => {
      const bot = new BotsRepo(deps.db).get(scope.botId);
      // An external agent's changes never go to Pi Bot's own model for a draft.
      if (bot?.kind === "agent") throw changesError("changes_draft_unavailable");
      const settings = new SettingsRepo(deps.db).get();
      const available = await abortable(deps.agent.listModels({ availableOnly: true }), signal);
      const candidates = [
        bot && bot.category !== "image" && bot.modelProvider && bot.modelId
          ? { provider: bot.modelProvider, id: bot.modelId }
          : undefined,
        settings.defaultModel ?? undefined,
      ];
      const model = candidates
        .flatMap((wanted) =>
          wanted
            ? available.filter((m) => m.provider === wanted.provider && m.id === wanted.id)
            : [],
        )
        .at(0);
      if (!model) throw changesError("changes_draft_unavailable");
      await abortable(deps.requireCredentials(model.provider), signal);
      const text = await summary(service, scope, paths, deps.redactor, signal);
      const language = resolvePersonaLanguage(
        settings.language,
        Intl.DateTimeFormat().resolvedOptions().locale,
      );
      const message = await draft({ summary: text, language, model, signal });
      deps.logger.info("Commit message drafted");
      return deps.redactor.redact(message);
    };
}
