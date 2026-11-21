import type { ConnectorManifest } from "@pibot/plugins-contract/full";
import { connectorsEn, connectorsZh } from "@pibot/plugins-contract/i18n";

// The add form used to save its own hint as the description; rows imported then still carry it.
const FORM_HINTS = new Set([
  connectorsZh["connectors.customNote"],
  connectorsEn["connectors.customNote"],
]);

/** Host for a remote server, executable name for a local one: never paths, args or secrets. */
export function mcpServerSummary(server: ConnectorManifest["servers"][number]): string {
  if (server.transport === "http") {
    try {
      return new URL(server.url).host;
    } catch {
      return "";
    }
  }
  if (server.transport === "stdio") return server.command.split(/[\\/]/).at(-1) ?? "";
  return "";
}

/** The service's own description when there is one, else what it connects to. */
export function mcpDescription(manifest: ConnectorManifest): ConnectorManifest["description"] {
  const { zh, en } = manifest.description;
  const placeholder = (text: string) => !text.trim() || FORM_HINTS.has(text);
  if (!placeholder(zh) && !placeholder(en)) return manifest.description;
  const summary = manifest.servers[0] ? mcpServerSummary(manifest.servers[0]) : "";
  if (!summary) return manifest.description;
  return { zh: placeholder(zh) ? summary : zh, en: placeholder(en) ? summary : en };
}
