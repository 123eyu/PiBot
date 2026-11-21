import { join } from "node:path";
import { createLogger } from "@pibot/observability";
import { BotsRepo, SecretStore, SettingsRepo } from "@pibot/storage";
import { resolvePersonaLanguage } from "../../core/personas/language.ts";
import { piPersonas } from "../../core/personas/pi.ts";
import { createBrainRedactor } from "../../core/privacy.ts";
import type { startBrain } from "../../index.ts";

interface StartupContext {
  db: import("node:sqlite").DatabaseSync;
  dataDir: string;
  opts: Parameters<typeof startBrain>[0];
}
export function createKernelStorage(ctx: StartupContext) {
  const settings = new SettingsRepo(ctx.db);
  const bots = new BotsRepo(ctx.db);
  const language = resolvePersonaLanguage(
    settings.get().language,
    Intl.DateTimeFormat().resolvedOptions().locale,
  );
  bots.ensureMainBot(piPersonas[language]);
  const redactor = createBrainRedactor();
  const logger = createLogger({
    dir: join(ctx.dataDir, "logs"),
    redactor,
    dev: ctx.opts.dev ?? false,
  });
  const secrets = new SecretStore(ctx.db, ctx.opts.host.secrets, redactor);
  return { settings, bots, language, redactor, logger, secrets };
}
