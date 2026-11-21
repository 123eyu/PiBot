import {
  DEFAULT_CODE_EXTENSIONS,
  groupWorkplace,
  workspaceFiles,
} from "@pibot/brain/orchestration-kit";
import type { Bot, Group, GroupPlanCard, GroupVerification, Run } from "@pibot/protocol-base";
import { BotsRepo } from "@pibot/storage";
import { isImplementationRole } from "@pibot/teams-contract";
import type { GroupService } from "./group-service.ts";

const CODE = new Set(DEFAULT_CODE_EXTENSIONS);
const BUILD = new Set(["makefile", "gnumakefile", "cmakelists.txt", "build.gradle"]);

export function verificationMembers(service: GroupService, group: Group): Bot[] {
  const bots = new BotsRepo(service.deps.db);
  return group.members.flatMap(({ botId }) => {
    const bot = bots.get(botId);
    return bot && !bot.archivedAt ? [bot] : [];
  });
}

export function implementationAuthors(facts: GroupVerification | undefined): string[] {
  return facts
    ? [...new Set([facts.authorBotId, ...(facts.sources?.map((item) => item.authorBotId) ?? [])])]
    : [];
}

export function verificationTeam(
  members: readonly Bot[],
  authorBotId?: string | readonly string[],
) {
  const authors = typeof authorBotId === "string" ? [authorBotId] : (authorBotId ?? []);
  if (!members.some((bot) => isImplementationRole(bot.role?.id))) return;
  const qa = members.find((bot) => bot.role?.id === "qa-engineer" && !authors.includes(bot.id));
  const reviewer = members.find(
    (bot) => bot.role?.id === "code-reviewer" && !authors.includes(bot.id),
  );
  return qa && reviewer ? { qa, reviewer } : undefined;
}

type ChangeRows = readonly import("@pibot/storage").RunFileSummary[];
type Paths = typeof import("node:path").posix;
type Isolated = { root: string; primary: string };

/** Every path a run changed in its working folder (or its own workspace), relative to it. */
export function changedFiles(rows: ChangeRows, paths: Paths, root: string, isolated?: Isolated) {
  return rows.flatMap((row) => {
    if (row.root !== root && !(isolated?.root === row.root && isolated.primary === root)) return [];
    if (
      row.kind !== "command" &&
      row.beforeRef === row.afterRef &&
      row.beforeMode === row.afterMode
    )
      return [];
    const relative = paths.relative(row.root, row.path).split(paths.sep).join("/");
    if (!relative || paths.isAbsolute(relative)) return [];
    const parts = relative.split("/").map((part) => part.toLowerCase());
    // Plan outputs live in <workplace>/.pibot/out, so that folder counts as work to verify;
    // the rest of .pibot (state, managed git) and any .cache never do.
    const output = parts[0] === ".pibot" && parts[1] === "out";
    if (
      parts.includes("..") ||
      parts.includes(".cache") ||
      parts.some((part, index) => part === ".pibot" && !(output && index === 0))
    )
      return [];
    return [relative];
  });
}

export function changedCodeFiles(
  rows: ChangeRows,
  paths: Paths,
  root: string,
  isolated?: Isolated,
) {
  return changedFiles(rows, paths, root, isolated).filter((file) => isCodeFile(file, paths));
}

/** Source, build and page files: what a code change touches, as opposed to a document. */
export function isCodeFile(file: string, paths: Pick<Paths, "extname" | "basename">) {
  return (
    CODE.has(paths.extname(file).toLowerCase()) ||
    BUILD.has(paths.basename(file).toLowerCase()) ||
    /\.(?:html?|ipynb)$/iu.test(file)
  );
}

export function changedDeliverableFiles(
  rows: ChangeRows,
  paths: Paths,
  root: string,
  isolated?: Isolated,
) {
  return [
    ...new Set([
      ...changedCodeFiles(rows, paths, root, isolated),
      ...changedFiles(rows, paths, root, isolated).filter((file) =>
        /\.(?:md|docx?|pdf|xlsx?|csv|tsv|pptx?|png|jpe?g|webp|gif|svg|avif|txt|rtf)$/iu.test(file),
      ),
    ]),
  ];
}

export async function verificationFacts(
  service: GroupService,
  run: Run,
  signal: AbortSignal,
  merged?: { root: string; primary: string },
): Promise<GroupVerification | undefined> {
  if (!run.groupId || !run.cycleId || run.status !== "done" || run.stopReason !== "stop") return;
  const group = service.active(run.groupId, run.botId);
  const place = await groupWorkplace(service.deps.local, run.botId, group, signal);
  const access = workspaceFiles(service.deps.local, place.boundary);
  const isolated = run.taskId ? service.memberWorktrees.isolated(run.taskId) : undefined;
  const paths = access.paths;
  const files = changedDeliverableFiles(
    service.deps.local.workspaceServices?.changes.turn.repo.summarize(run.id) ?? [],
    paths,
    place.cwd,
    merged ?? isolated,
  );
  signal.throwIfAborted();
  if (!files.length) return;
  let bytes = 0;
  const selected: string[] = [];
  for (const file of new Set(files)) {
    if (selected.length === 500 || bytes + file.length > 16000) break;
    selected.push(file);
    bytes += file.length;
  }
  return {
    sourceRunId: run.id,
    authorBotId: run.botId,
    workspaceRoot: place.cwd,
    workspaceRevision: group.workspaceRevision ?? 0,
    target: access.location?.target ?? "local",
    ...(access.revision !== undefined ? { revision: access.revision } : {}),
    files: selected,
    truncated: files.length > selected.length,
  };
}

export function initialVerification(card: GroupPlanCard) {
  return (
    !!card.verification &&
    card.verification.sourceRunId === card.originRunId &&
    !card.replacesWorkflowRunId
  );
}
