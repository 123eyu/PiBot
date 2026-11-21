import { AgentError, type AgentRuntime } from "@pibot/agent";
import { abortable, resolvePersonaLanguage } from "@pibot/brain/kit";
import type { Logger } from "@pibot/observability";
import type { Redactor } from "@pibot/secrets";
import {
  AbsolutePathSchema,
  DomainSchema,
  type Recording,
  RpcError,
  RpcErrorCodes,
  type SkillDraft,
  SkillDraftSchema,
  SkillParamSchema,
  type TeachStep,
} from "@pibot/skills-contract/full";
import { BotsRepo, SettingsRepo } from "@pibot/storage";
import { z } from "zod";

/** Only the reviewed steps, redacted and bounded, reach the model. */
const STEPS_CHARS = 16_000;

export const teachError = (code: string, rpc: number = RpcErrorCodes.invalidParams) =>
  new RpcError(rpc, code);

/** What the model answers; lenient on shape, everything is re-validated as a SkillDraft. */
const ModelDraftSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  steps: z.array(z.string()).min(1).max(200),
  params: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().optional(),
        default: z.string().optional(),
      }),
    )
    .max(40)
    .optional(),
  sendTo: z.array(z.string()).max(100).optional(),
  writePaths: z.array(z.string()).max(100).optional(),
});

const plain = (value: string | undefined, max: number) =>
  [...(value ?? "")]
    .map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

function stepLine(step: TeachStep) {
  const where = step.url ? ` (page ${step.url})` : "";
  switch (step.kind) {
    case "navigate":
      return `open ${step.target}`;
    case "click":
      return step.value
        ? `${step.value === "checked" ? "check" : "uncheck"} "${step.target}"${where}`
        : `click "${step.target}"${where}`;
    case "type":
      return step.secret
        ? `type into the password field "${step.target}" (value not recorded)${where}`
        : `type "${step.value ?? ""}" into "${step.target}"${where}`;
    case "select":
      return `choose "${step.value ?? ""}" in "${step.target}"${where}`;
    case "submit":
      return `submit the form "${step.target}"${where}`;
    case "download":
      return `download the file "${step.target}"`;
  }
}

/** Numbered step text for the model; values were redacted when the steps were recorded. */
export function stepsForModel(steps: readonly TeachStep[], redactor: Redactor) {
  const lines: string[] = [];
  let size = 0;
  for (const step of steps) {
    const line = redactor.redact(`${step.index + 1}. ${stepLine(step)}`).slice(0, 2400);
    if (size + line.length > STEPS_CHARS) {
      lines.push(`… ${steps.length - lines.length} more steps`);
      break;
    }
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n");
}

/** Sites come from what was actually visited, not from the model. */
export function recordedDomains(steps: readonly TeachStep[]) {
  const domains = new Set<string>();
  for (const step of steps) {
    try {
      const host = new URL(step.url).hostname;
      const parsed = DomainSchema.safeParse(host);
      if (parsed.success && /^https?:$/.test(new URL(step.url).protocol)) domains.add(parsed.data);
    } catch {
      // A step without a web address (download) has no site.
    }
    if (domains.size >= 50) break;
  }
  return [...domains];
}

export function buildDraft(recording: Recording, answer: unknown): SkillDraft {
  const parsed = ModelDraftSchema.safeParse(answer);
  if (!parsed.success) throw teachError("teach_draft_failed", RpcErrorCodes.internal);
  const model = parsed.data;
  const params = new Map<string, z.infer<typeof SkillParamSchema>>();
  for (const param of model.params ?? []) {
    const value = SkillParamSchema.safeParse({
      name: plain(param.name, 40).replace(/\s+/g, "_"),
      ...(param.description ? { description: plain(param.description, 200) } : {}),
      ...(param.default !== undefined ? { default: plain(param.default, 1000) } : {}),
    });
    if (value.success && !params.has(value.data.name) && params.size < 20)
      params.set(value.data.name, value.data);
  }
  const name = plain(model.name, 80) || "Skill";
  // Drafting only merges recorded steps, so more steps than were recorded means the model made
  // some up despite the instruction (a lone "open the page" became "open, then search {term}").
  const body = model.steps
    .map((step) => plain(step, 1000))
    .filter(Boolean)
    .slice(0, recording.steps.length)
    .map((step, i) => `${i + 1}. ${step}`)
    .join("\n");
  // A parameter no kept step uses would be asked for and then ignored.
  for (const key of params.keys()) if (!body.includes(`{${key}}`)) params.delete(key);
  const draft = SkillDraftSchema.safeParse({
    name,
    description: plain(model.description, 1024) || name,
    body: body || "1. —",
    params: [...params.values()],
    recordingId: recording.id,
    permissions: {
      domains: recordedDomains(recording.steps),
      writePaths: (model.writePaths ?? [])
        .filter((path) => AbsolutePathSchema.safeParse(path).success)
        .slice(0, 50),
      sendTo: (model.sendTo ?? [])
        .map((who) => plain(who, 200))
        .filter(Boolean)
        .slice(0, 50),
    },
    trigger: "chat",
  });
  if (!draft.success) throw teachError("teach_draft_failed", RpcErrorCodes.internal);
  return draft.data;
}

export interface SkillDrafterDeps {
  agent: AgentRuntime;
  db: ConstructorParameters<typeof BotsRepo>[0];
  redactor: Redactor;
  logger: Logger;
  requireCredentials(provider: string): Promise<void>;
}

/** Uses the Bot's own text model, falling back to the default model (like commit drafts). */
export function createSkillDrafter(deps: SkillDrafterDeps) {
  return async (recording: Recording, signal: AbortSignal): Promise<SkillDraft> => {
    const draft = deps.agent.draftSkill?.bind(deps.agent);
    if (!draft) throw teachError("teach_draft_unavailable", RpcErrorCodes.unsupported);
    const bot = new BotsRepo(deps.db).get(recording.botId);
    const settings = new SettingsRepo(deps.db).get();
    const available = await abortable(deps.agent.listModels({ availableOnly: true }), signal);
    const model = [
      bot && bot.category !== "image" && bot.modelProvider && bot.modelId
        ? { provider: bot.modelProvider, id: bot.modelId }
        : undefined,
      settings.defaultModel ?? undefined,
    ]
      .flatMap((wanted) =>
        wanted ? available.filter((m) => m.provider === wanted.provider && m.id === wanted.id) : [],
      )
      .at(0);
    if (!model) throw teachError("teach_draft_no_model", RpcErrorCodes.noModel);
    await abortable(deps.requireCredentials(model.provider), signal);
    const language = resolvePersonaLanguage(
      settings.language,
      Intl.DateTimeFormat().resolvedOptions().locale,
    );
    let answer: unknown;
    try {
      answer = await draft({
        steps: stepsForModel(recording.steps, deps.redactor),
        language,
        model,
        signal,
      });
    } catch (error) {
      if (error instanceof AgentError && error.code === "aborted") throw error;
      deps.logger.warn(
        `Skill draft failed: ${error instanceof AgentError ? error.code : "invalid_answer"}`,
      );
      throw teachError("teach_draft_failed", RpcErrorCodes.internal);
    }
    const result = buildDraft(recording, answer);
    deps.logger.info(`Skill drafted botId=${recording.botId} steps=${recording.steps.length}`);
    return result;
  };
}
