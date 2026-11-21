import type { RegisterRpc } from "@pibot/brain/kit";
import { resolvePersonaLanguage } from "@pibot/brain/kit";
import { SettingsRepo } from "@pibot/storage";
import { createSkillDrafter } from "./teach-draft.ts";
import { TeachService } from "./teach-service.ts";

/** Registered through brain's single RPC wrapper (validation, redacted logging, error mapping). */
export function registerTeachRpc(handle: RegisterRpc, teach: TeachService) {
  handle("teach.start", ({ botId, url }) => teach.start(botId, url));
  handle("teach.current", ({ botId }) => teach.current(botId));
  handle("teach.stop", ({ recordingId }) => teach.stop(recordingId));
  handle("teach.pause", ({ recordingId, paused }) => teach.pause(recordingId, paused));
  handle("teach.review", async ({ recordingId }) => teach.review(recordingId));
  handle("teach.thumbnail", ({ recordingId, index }) => teach.thumbnail(recordingId, index));
  handle("teach.draft", ({ recordingId, keep }) => teach.draft(recordingId, keep));
  handle("teach.trial", ({ botId, draft }) => teach.trial(botId, draft));
  handle("teach.save", ({ botId, draft }) => teach.save(botId, draft));
  handle("teach.discard", ({ recordingId }) => teach.discard(recordingId));
}

/** The capability injects the existing browser overlay as a narrow takeover function. */
export function createTeach(deps: {
  ctx: import("@pibot/brain/kit").CapabilityContext;
  skills: import("./teach-skill.ts").TeachSkills;
  shutdown: AbortSignal;
}) {
  const { ctx } = deps;
  return new TeachService({
    db: ctx.db,
    dataDir: ctx.dataDir,
    host: ctx.host.browser,
    takeover: (botId, on) => ctx.skills.takeover(botId, on),
    network: (botId) => {
      const network = ctx.local.permissions.effective(botId).network;
      const proxy = ctx.local.deps.proxy?.();
      return {
        allowList: network.allowAll ? null : network.domains,
        proxy: proxy ? { url: proxy.url } : null,
        // Teaching on the Bot's own loopback service (its dev server) is not a private
        // network visit; without the ports the recording page was blocked.
        localPorts: ctx.local.background.ports(botId),
      };
    },
    drafter: createSkillDrafter({ ...ctx, requireCredentials: ctx.credentials }),
    skills: deps.skills,
    startTrial: async (botId, text) => {
      const sent = await ctx.chat.send(botId, text, [], [], undefined, true);
      return {
        runId: sent.runId,
        ...(sent.conversationId ? { topicId: sent.conversationId } : {}),
      };
    },
    language: () =>
      resolvePersonaLanguage(
        new SettingsRepo(ctx.db).get().language,
        Intl.DateTimeFormat().resolvedOptions().locale,
      ),
    peer: ctx.peer,
    redactor: ctx.redactor,
    logger: ctx.logger,
    shutdown: deps.shutdown,
  });
}
