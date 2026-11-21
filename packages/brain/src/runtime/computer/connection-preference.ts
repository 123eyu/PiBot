import { MessagesRepo, RunsRepo } from "@pibot/storage";
import type { ToolRunContext } from "../../core/local-types.ts";
import type { LocalService } from "../../local-service.ts";
import { resolvedConnectorCapabilities } from "../tools/connectors/capability-filter.ts";
import { type LocalAppConnection, localAppNextStep } from "../tools/connectors/local-app-result.ts";
import type { ToolInput } from "../tools/tools.ts";
import { directAppRequest } from "./direct-app-request.ts";

function systemApp(value: string): LocalAppConnection[] {
  const app = value.normalize("NFKC").trim().toLowerCase();
  if (
    [
      "com.apple.addressbook",
      "contacts",
      "contacts.app",
      "address book",
      "addressbook",
      "通讯录.app",
      "org.gnome.contacts.desktop",
      "peopleapp.exe",
      "microsoft.windowscommunicationsapps",
      "通讯录",
      "org.gnome.contacts",
      "people",
    ].includes(app)
  )
    return ["contacts"];
  if (
    [
      "com.apple.ical",
      "calendar",
      "calendar.app",
      "日历",
      "日历.app",
      "ical",
      "org.gnome.calendar",
      "org.gnome.calendar.desktop",
      "hxcalendarappimm.exe",
    ].includes(app)
  )
    return ["calendar"];
  if (
    [
      "outlook.exe",
      "olk.exe",
      "evolution",
      "org.gnome.evolution",
      "org.gnome.evolution.desktop",
      "outlook",
      "microsoft outlook",
      "microsoft outlook.app",
      "com.microsoft.outlook",
    ].includes(app)
  )
    return ["contacts", "calendar"];
  return [];
}

/** A request to find data is not a request to operate an app; quoted references cannot opt in. */
export function explicitlyOperateLocalApp(text: string, app: LocalAppConnection) {
  const name =
    app === "contacts" ? "(?:通讯录|contacts|people|outlook)" : "(?:日历|calendar|outlook)";
  return directAppRequest(text)
    .split(/[。！？!?\n;]/u)
    .some((sentence) => {
      if (/不要|别|禁止|\b(?:not|never|don't)\b/iu.test(sentence)) return false;
      return (
        new RegExp(
          `^\\s*(?:请|帮我|请帮我)?(?:打开|操作|点击|点开|使用电脑操作)\\s*(?:系统(?:的)?)?[「『“"\`]?${name}[」』”"\`]?(?:\\s*(?:App|应用))?`,
          "iu",
        ).test(sentence) ||
        new RegExp(
          `^\\s*(?:please\\s+)?(?:open|operate|control|click)\\s+(?:the\\s+)?(?:system\\s+)?${name}\\b`,
          "iu",
        ).test(sentence)
      );
    });
}

/** Legacy wording helper only; authority checks use resolved IDs through ComputerRuntime. */
export function preferConnectedLocalApp(
  local: LocalService,
  context: ToolRunContext,
  input: ToolInput,
): string | undefined {
  if (!("app" in input.args) || typeof input.args.app !== "string") return;
  return connectedLocalAppRestriction(local, context, input.tool, input.args.app);
}

/** Authority callers supply the app ID obtained from the trusted host / granted app list. */
export function connectedLocalAppRestriction(
  local: LocalService,
  context: ToolRunContext,
  tool: string,
  canonicalAppId: string,
): string | undefined {
  const target = context.permissionGroupId ?? context.groupId;
  const scope = target
    ? { kind: "group" as const, id: target }
    : { kind: "bot" as const, id: context.botId };
  // Native UI inputs cannot prove which connector write they implement. Preserve every
  // disabled write boundary rather than letting a generic click override it.
  if (["ui_action", "pointer", "keys", "open_file"].includes(tool)) {
    for (const app of systemApp(canonicalAppId)) {
      const status = local.connectors?.availability?.(scope, app);
      if (status?.confirmationMode === "read_only")
        return "连接设为只读；请去连接设置修改，不能通过操作电脑写入 / Connection is read-only; change Connections settings before writing through the system app";
      const connector = status?.connectorId && local.connectors?.get(status.connectorId);
      const writes =
        app === "contacts"
          ? ["create_contact", "update_contact", "delete_contact"]
          : ["create_event", "update_event", "delete_event"];
      if (
        connector &&
        writes.some(
          (name) =>
            local.connectors?.tool(connector.id, connector.catalogVersion, name)?.enabled === false,
        )
      )
        return "连接的写工具已停用；请去连接设置修改，不能通过操作电脑绕过 / Connection write tools are disabled; change Connections settings before using system-app input";
    }
  }
  const selections = resolvedConnectorCapabilities(local, context);
  const apps = systemApp(canonicalAppId).filter((app) => {
    if (selections.get(app)?.startsWith("connector:")) return true;
    // A failed connection may disappear from the next run's served-tool selection.
    const availability = local.connectors?.availability?.(
      context.groupId ? { kind: "group", id: context.groupId } : { kind: "bot", id: context.botId },
      app,
    );
    return (
      availability &&
      [
        "available",
        "error",
        "needs_auth",
        "tool_disabled",
        "unknown_tool",
        "read_only_mode",
      ].includes(availability.reason)
    );
  });
  if (!apps.length) return;
  const run = new RunsRepo(local.deps.db).get(context.runId);
  const message = run?.userMessageId
    ? new MessagesRepo(local.deps.db).get(run.userMessageId)
    : undefined;
  const request =
    run?.botId === context.botId &&
    run.conversationId === context.conversationId &&
    message?.role === "user" &&
    message.conversationId === context.conversationId
      ? message.content
      : "";
  const blocked = apps.find((app) => !explicitlyOperateLocalApp(request, app));
  return blocked
    ? `请用已连接的通讯录 / 日历 / Use the connected contacts / calendar. ${localAppNextStep(blocked)}`
    : undefined;
}
