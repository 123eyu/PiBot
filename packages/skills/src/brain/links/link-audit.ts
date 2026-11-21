import type { CapabilityContext } from "@pibot/brain/kit";
import type { LinkSource } from "./link-source.ts";

export function auditDownload(
  ctx: CapabilityContext,
  actorBotId: string,
  source: LinkSource,
  bytes: number,
  result: string,
  commit?: string,
) {
  ctx.local.approvals.audit.append({
    botId: actorBotId,
    kind: "skill.downloaded",
    summary: "Skill download / 技能下载",
    detail: {
      actor: "user",
      bytes,
      reasonCode: result,
      skillDownload: {
        host: source.host,
        ...(source.owner ? { owner: source.owner } : {}),
        ...(source.repo ? { repo: source.repo } : {}),
        ...(source.ref ? { ref: source.ref } : {}),
        ...(commit ? { commit } : {}),
      },
    },
  });
}
