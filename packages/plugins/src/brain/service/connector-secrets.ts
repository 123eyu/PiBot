import type { SecretUse, UserSecretsPort } from "@pibot/brain/kit";
import type { ConnectorServer } from "@pibot/plugins-contract/full";
import { ConnectorOpenError } from "./connector-runtime.ts";

/** Installation-generated credentials never become global user assignments. */
export function connectorSecretUses(
  server: ConnectorServer,
  installationId: string,
  users?: UserSecretsPort,
  botId?: string,
): SecretUse[] {
  if (server.auth.kind === "system") return [];
  const names = new Set(server.auth.secretNames);
  const prefix = `IMPORT_${installationId.replaceAll("-", "").toUpperCase()}_`;
  const uses: SecretUse[] = [];
  for (const name of names) {
    if (name.startsWith("IMPORT_")) {
      if (!name.startsWith(prefix))
        throw new ConnectorOpenError(
          "secret_required",
          "Imported credential belongs to another installation",
        );
      continue;
    }
    const meta = users?.metadata(name);
    if (
      !meta?.hasValue ||
      (botId && meta.assignment.kind === "bots" && !meta.assignment.bots.includes(botId))
    )
      throw new ConnectorOpenError("secret_required", "User secret unavailable or unassigned");
    uses.push({ name, revision: meta.revision });
  }
  return uses.sort((a, b) => a.name.localeCompare(b.name));
}
