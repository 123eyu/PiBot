import type { ConnectionAvailability, ConnectionTarget } from "@pibot/protocol-base";
import type { ConnectorsPort } from "./port.ts";

const reasons: Record<ConnectionAvailability["reason"], string> = {
  not_connected: "Not connected. Open connection settings.",
  needs_auth: "Authorization needs renewal.",
  error: "Connection failed. Review its settings.",
  platform_unsupported: "Unsupported on this platform.",
  disabled: "Connection is disabled.",
  no_access: "This Bot or group has no access.",
  tool_disabled: "This tool is disabled.",
  unknown_tool:
    "This connection has no tool by that name; use connector_discover to see its tools.",
  read_only_mode: "Writes are disabled by read-only mode.",
  available: "Available; final policy still applies.",
};
/** Only the capability's trusted labels and fixed explanations enter the instruction. */
export function unavailableConnectionSummary(
  port: Pick<ConnectorsPort, "unavailable"> | undefined,
  target: ConnectionTarget,
) {
  const items = port?.unavailable?.(target) ?? [];
  if (!items.length) return "";
  const rows = items
    .toSorted((a, b) => Number(localConnection(b)) - Number(localConnection(a)))
    .slice(0, 8)
    .map(
      (item) =>
        `${item.trustedName?.en ?? "Imported connection"} [${item.connection}]: ${item.reason}. ${reasons[item.reason]}${localConnection(item) ? ` Use connection_needed({connection:"${item.connection}"}) to show 连接 › ${item.trustedName?.zh} / Connections > ${item.trustedName?.en}. Desktop contacts/calendar are connections, not phone tools.` : ""}`,
    );
  return (
    "\nConnection status (bounded snapshot; recheck using connection_needed):\n" +
    rows.join("\n") +
    (items.length > rows.length ? "\nMore connections omitted; query by connection id." : "")
  );
}

function localConnection(item: ConnectionAvailability) {
  return (
    !!item.trustedName &&
    item.reason !== "platform_unsupported" &&
    ["contacts", "calendar"].includes(item.connection)
  );
}
