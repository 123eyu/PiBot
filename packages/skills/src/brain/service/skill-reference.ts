import { skillReferenceText } from "@pibot/brain/kit";
import { RpcError, RpcErrorCodes } from "@pibot/skills-contract/full";
import type { SkillService } from "./skill-service.ts";

/** Selection is re-read at invocation, so disabling a skill removes access immediately. */
export async function readSkillReference(
  service: SkillService,
  botId: string,
  name: string | undefined,
  language: "zh" | "en",
  signal: AbortSignal,
) {
  signal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  signal.throwIfAborted();
  service.activeBot(botId);
  await service.preparePromptPackages(botId, signal);
  if (!name)
    return JSON.stringify(
      service.promptEntries(botId).map(({ name, description }) => ({ name, description })),
    );
  const rows = service.repo
    .enabledForPrompt(botId)
    .filter((row) => row.name === name || service.deps.redactor.redact(row.name) === name);
  if (rows.length !== 1 || !rows[0])
    throw new RpcError(RpcErrorCodes.invalidParams, "skill_not_found");
  const row = rows[0];
  const document = await service.document(row, signal);
  signal.throwIfAborted();
  service.activeBot(botId);
  // A disk read may yield; the same effective entry must still be enabled afterwards.
  if (
    !service.repo
      .enabledForPrompt(botId)
      .some(
        (current) =>
          current.id === row.id &&
          current.updatedAt === row.updatedAt &&
          current.packageId === row.packageId &&
          current.path === row.path,
      )
  )
    throw new RpcError(RpcErrorCodes.invalidParams, "skill_not_found");
  return skillReferenceText(service.deps.redactor.redact(document.body), language);
}
