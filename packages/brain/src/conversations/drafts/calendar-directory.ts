import { z } from "zod";
import type { ToolRunContext } from "../../core/local-types.ts";
import type { PreparedConnector } from "../../runtime/tools/connectors/connector-tools.ts";

const directory = z.object({
  items: z.array(z.object({ id: z.string().max(4096), title: z.string().max(512) })).max(100),
});
const events = z.object({
  items: z
    .array(z.object({ calendarId: z.string().max(4096), calendarName: z.string().max(512) }))
    .max(100),
});
const envelope = z.object({
  content: z
    .array(
      z.object({
        type: z.string(),
        text: z
          .string()
          .max(64 * 1024)
          .optional(),
      }),
    )
    .max(100),
});

/** Display-only names from this conversation's authorized list; never resolve or authorize a target. */
export class CalendarDirectory {
  private readonly entries = new Map<string, { expires: number; names: Map<string, string> }>();
  private key(
    botId: string,
    conversationId: string,
    connectorId: string,
    revision: number,
    catalog: number,
  ) {
    return JSON.stringify([botId, conversationId, connectorId, revision, catalog]);
  }
  observeDirectory(context: ToolRunContext, prepared: PreparedConnector, value: unknown) {
    if (
      !context.conversationId ||
      prepared.tool.tool !== "list_calendars" ||
      !prepared.tool.readOnly
    )
      return;
    this.remember(context, prepared, value);
  }
  observe(context: ToolRunContext, prepared: PreparedConnector, value: unknown) {
    if (
      !context.conversationId ||
      prepared.tool.capabilityId !== "calendar" ||
      !(
        (prepared.tool.capabilityTool === "calendar_list_calendars" &&
          prepared.tool.tool === "list_calendars") ||
        (prepared.tool.capabilityTool === "calendar_list_events" &&
          prepared.tool.tool === "list_events")
      )
    )
      return;
    this.remember(context, prepared, value);
  }
  private remember(context: ToolRunContext, prepared: PreparedConnector, value: unknown) {
    if (!context.conversationId) return;
    const wrapped = envelope.safeParse(value);
    if (!wrapped.success) return;
    for (const item of wrapped.data.content) {
      if (item.type !== "text" || !item.text) continue;
      let decoded: unknown;
      try {
        decoded = JSON.parse(item.text);
      } catch {
        continue;
      }
      const listed =
        prepared.tool.tool === "list_calendars" ? directory.safeParse(decoded) : undefined;
      const page = prepared.tool.tool === "list_events" ? events.safeParse(decoded) : undefined;
      if (!listed?.success && !page?.success) continue;
      const names = listed?.success
        ? listed.data.items.map((entry) => [entry.id, entry.title] as const)
        : page?.success
          ? page.data.items.map((entry) => [entry.calendarId, entry.calendarName] as const)
          : [];
      const connector = prepared.connector;
      const key = this.key(
        context.botId,
        context.conversationId,
        connector.id,
        connector.revision,
        connector.catalogVersion,
      );
      const previous = this.entries.get(key);
      const merged = new Map(
        !listed?.success && previous && previous.expires > Date.now() ? previous.names : [],
      );
      for (const [id, name] of names) {
        merged.delete(id);
        merged.set(id, name);
        if (merged.size > 100) merged.delete(merged.keys().next().value as string);
      }
      this.entries.delete(key);
      this.entries.set(key, {
        expires: Date.now() + 300_000,
        names: merged,
      });
      if (this.entries.size > 64) this.entries.delete(this.entries.keys().next().value as string);
    }
  }
  name(
    botId: string,
    conversationId: string,
    connectorId: string,
    revision: number,
    catalog: number,
    id: unknown,
  ) {
    if (typeof id !== "string") return undefined;
    const entry = this.entries.get(this.key(botId, conversationId, connectorId, revision, catalog));
    return entry && entry.expires > Date.now() ? entry.names.get(id) : undefined;
  }
  dispose() {
    this.entries.clear();
  }
}
