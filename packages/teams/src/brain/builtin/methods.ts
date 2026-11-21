import type { CapabilityContext, SkillsPort } from "@pibot/brain/kit";
import { BuiltinMethodTargetsRepo } from "../../store/builtin-methods.ts";
import type { BuiltinService } from "./service.ts";

export const researchMethodKeys: readonly string[] = Object.freeze([
  "research-report",
  "competitive-analysis",
  "source-notes",
  "periodic-brief",
  "analysis-report",
  "brief-data",
  "fact-check",
  // Shipped with the data-analyst role like the methods above; without a key they kept
  // their install language in an interface of the other language (no builtinLabels).
  "chart-guidelines",
  "csv-profile",
]);

/** App methods are provisioned independently of optional role upgrades and plugin grants. */
export async function provisionBuiltinMethods(
  ctx: Pick<CapabilityContext, "db" | "redactor" | "logger" | "local">,
  builtin: BuiltinService,
  skills: SkillsPort,
  language: "zh" | "en",
  signal: AbortSignal,
) {
  if (!skills.ensureBuiltin) throw new Error("builtin_skills_port_unavailable");
  const content = await builtin.content();
  const targets = new BuiltinMethodTargetsRepo(ctx.db);
  const ensure = skills.ensureBuiltin;
  const install = async (botId: string, input: Parameters<typeof ensure>[1], groupId?: string) => {
    signal.throwIfAborted();
    try {
      const targetSignal = AbortSignal.any([signal, AbortSignal.timeout(25_000)]);
      await ensure(botId, input, targetSignal, groupId);
    } catch (error) {
      if (signal.aborted) throw error;
      ctx.logger.warn(
        JSON.stringify({
          module: "builtin",
          event: "method_provision_failed",
          botId,
          key: input.key,
          ...(groupId ? { groupId } : {}),
        }),
      );
    }
  };
  let after = "";
  while (true) {
    signal.throwIfAborted();
    const page = targets.page(after);
    if (!page.length) return;
    for (const target of page) {
      signal.throwIfAborted();
      const pack = content.roles.get(target.roleId)?.[language];
      if (!pack) continue;
      const packages = (pack.skills[0] ?? []).filter((pkg) =>
        researchMethodKeys.includes(pkg.folder),
      );
      for (const pkg of packages) {
        signal.throwIfAborted();
        const input = { key: pkg.folder, document: pkg.document, files: pkg.files };
        await install(target.botId, input);
        let cursor = "";
        while (true) {
          signal.throwIfAborted();
          const groups = targets.groups(target.botId, cursor);
          for (const groupId of groups) await install(target.botId, input, groupId);
          if (groups.length < 50) break;
          cursor = groups.at(-1) as string;
        }
      }
    }
    after = page.at(-1)?.botId ?? after;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}
