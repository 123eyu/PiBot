import pathApi from "node:path";
import type { Bot, SkillContract } from "@pibot/protocol-base";
import { MessagesRepo, RunFileChangesRepo, RunsRepo } from "@pibot/storage";
import type { ToolRunContext } from "../../core/local-types.ts";
import type { LocalService } from "../../local-service.ts";
import { resolveRunWorkplace } from "../../resources/workplaces/run-workplace.ts";
import { workspaceFiles } from "../../resources/workplaces/workspace-files.ts";
import type { DeliveryContract } from "./delivery-check.ts";
import { emptySources } from "./delivery-citations.ts";
import { hasRequestedOutputDirectory } from "./delivery-format.ts";
import { DeliveryRun } from "./delivery-run.ts";
import { requestedOutputNames, requestedOutputSections } from "./requested-output-names.ts";
import { outputRootEnd } from "./workflow-folder.ts";

const ROLES = new Set(["researcher", "data-analyst", "general-assistant"]);
const DOCUMENTS = new Set([".md", ".docx", ".xlsx", ".pptx", ".csv"]);
const academic =
  /申报|学术|论文|文献综述|grant (?:application|proposal)|academic|literature review|thesis/iu;

/** Infer only observed new outputs; existing source documents and explicit filenames keep their contract. */
export function roleDeliveryRun(
  local: LocalService,
  context: ToolRunContext,
  bot: Bot,
  request: string,
) {
  const place = context.runWorkplace;
  const role = ROLES.has(bot.role?.id ?? "");
  // A group coordinator of any role may work solo; whether it did is only known at check time.
  const soloPort = context.groupId ? local.collaboration?.soloDelivery : undefined;
  if (
    (!role && !soloPort) ||
    !place ||
    (place.boundary.location?.target.startsWith("runner:") && !context.groupId)
  )
    return;
  const access = workspaceFiles(local, place.boundary);
  const { basename, extname, isAbsolute, relative, resolve, sep } = access.paths ?? pathApi;
  const folder = place.boundary.primaryPath;
  // Member steps receive assistant instructions; L4, not assistant prose, vouches for their names.
  const run = new RunsRepo(local.deps.db).get(context.runId);
  const source = run?.userMessageId
    ? new MessagesRepo(local.deps.db).get(run.userMessageId)
    : undefined;
  const step = !!run?.taskId && (run.kind === "group_task" || run.kind === "wake");
  const userText =
    source?.role === "user" && source.conversationId === context.conversationId
      ? source.content
      : "";
  const requestedNames = new Set(
    step
      ? (local.collaboration?.deliveryOutputNames?.(context.runId) ?? [])
      : requestedOutputNames(userText),
  );
  // A step's sections come from its plan contract, never from the user's prose.
  const requestedSections = step ? new Map<string, string[]>() : requestedOutputSections(userText);
  const defaultOutputDirectory = !hasRequestedOutputDirectory(request);
  const contract = async (signal: AbortSignal): Promise<DeliveryContract> => {
    signal.throwIfAborted();
    local.tasks.guardSync(context);
    if (
      context.todoRun?.paused ||
      local.tasks.hasPendingChildren(context) ||
      local.background.waitingRun(context.runId) ||
      local.approvals.repo.blocksTaskCompletion(context.runId)
    )
      return { deliverables: [], acceptance: [] };
    const solo = soloPort ? await soloPort.call(local.collaboration, context, signal) : undefined;
    if (!role && !solo) return { deliverables: [], acceptance: [] };
    // Re-resolve live roots before reading evidence; a stored path is never an authorization.
    const current = await resolveRunWorkplace(local, context, signal);
    if (current.boundary.primaryPath !== folder) return { deliverables: [], acceptance: [] };
    const changes = new RunFileChangesRepo(local.deps.db).summarize(context.runId);
    signal.throwIfAborted();
    const deliverables: SkillContract["deliverables"] = [];
    const acceptance: SkillContract["acceptance"] = [];
    const produced = new Set<string>();
    for (const file of changes) {
      // Command observations prove only contact, never absence before creation.
      if (file.kind !== "add" || file.beforeRef || !file.afterRef) continue;
      const absolute = resolve(file.root, file.path);
      const path = relative(folder, absolute).split(sep).join("/");
      const extension = extname(path).toLowerCase();
      const requestedName = requestedNames.has(basename(absolute));
      if (
        !DOCUMENTS.has(extension) ||
        !path ||
        path.length > 200 ||
        isAbsolute(path) ||
        path === ".." ||
        path.startsWith("../") ||
        !current.boundary.writeRoots.some((root) => {
          const rel = relative(root, absolute);
          return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
        })
      )
        continue;
      // Markdown/CSV need an output tree or an explicit save directive to avoid checking source code.
      if (
        defaultOutputDirectory &&
        !requestedName &&
        (extension === ".md" || extension === ".csv") &&
        outputRootEnd(path.split("/")) < 0
      )
        continue;
      const id = `output${deliverables.length + 1}`;
      const name = basename(absolute);
      const own: SkillContract["acceptance"] = [];
      // The caller's explicit filename takes precedence; never force-renames or relocates a file.
      if (role || requestedName)
        own.push({
          id: `${id}-name`,
          check: requestedName ? "exists" : "fileNaming",
          deliverable: id,
        });
      if (
        role &&
        (extension === ".md" || extension === ".docx") &&
        academic.test(`${request}\n${name}`) &&
        !/\b(?:APA|MLA|Chicago|Vancouver|IEEE)\b/iu.test(request)
      )
        own.push({ id: `${id}-references`, check: "gbt7714", deliverable: id });
      const sections = solo ? soloSections(solo.methods, name, requestedSections.get(name)) : [];
      if (sections.length) own.push({ id: `${id}-sections`, check: "sections", deliverable: id });
      produced.add(name);
      if (!own.length) continue;
      deliverables.push({
        id,
        path,
        kind: kindOf(extension),
        ...(sections.length ? { sections } : {}),
      });
      acceptance.push(...own);
      if (deliverables.length === 10) break;
    }
    // Solo work has no plan to hold the request's names; an absent requested file is a failure
    // the one fix round can still correct. Any touched file of that name already answers it.
    if (solo)
      for (const name of requestedNames) {
        if (deliverables.length >= 10) break;
        if (produced.has(name) || changes.some((file) => basename(file.path) === name)) continue;
        const extension = extname(name).toLowerCase();
        if (!DOCUMENTS.has(extension)) continue;
        const id = `output${deliverables.length + 1}`;
        deliverables.push({ id, path: name, kind: kindOf(extension) });
        acceptance.push({ id: `${id}-name`, check: "exists", deliverable: id });
      }
    return { deliverables, acceptance, defaultOutputDirectory };
  };
  return new DeliveryRun({
    workflow: {
      name: context.language === "zh" ? "交付格式" : "Delivery format",
      version: null,
      contract: {
        inputs: [],
        prechecks: [],
        deliverables: [],
        acceptance: [],
        stop: [],
        approvals: [],
        maxFixRounds: 1,
      },
    },
    contract,
    folder,
    sources: () => ({ ...emptySources(), access }),
    office: () => local.officeProvider,
    language: context.language,
    signal: context.signal,
    logger: local.deps.logger,
    runId: context.runId,
    botId: bot.id,
  });
}

function kindOf(extension: string): "md" | "docx" | "xlsx" | "pptx" {
  return extension === ".docx" || extension === ".xlsx" || extension === ".pptx"
    ? (extension.slice(1) as "docx" | "xlsx" | "pptx")
    : "md";
}

/** Sections the request names for this file, plus those of a member method with the same name. */
function soloSections(
  methods: readonly Pick<SkillContract, "deliverables" | "acceptance">[],
  name: string,
  requested: readonly string[] = [],
) {
  const sections = new Set(requested);
  for (const method of methods)
    for (const deliverable of method.deliverables)
      if (
        pathApi.posix.basename(deliverable.path) === name &&
        method.acceptance.some(
          (item) => item.check === "sections" && item.deliverable === deliverable.id,
        )
      )
        for (const section of deliverable.sections ?? []) sections.add(section);
  return [...sections].slice(0, 20);
}
