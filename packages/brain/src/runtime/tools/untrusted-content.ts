import type { PreparedTool, ToolRunContext } from "../../core/local-types.ts";

export function noteUntrustedContent(context: ToolRunContext) {
  context.untrustedContent ??= { seen: false };
  context.untrustedContent.seen = true;
}

/** Record provenance before returned content reaches the model, including journal replays. */
export function readsUntrustedContent(prepared: PreparedTool) {
  const tool = prepared.call.tool;
  return (
    !!prepared.connector ||
    !!prepared.capabilityConnector ||
    tool.startsWith("browser_") ||
    [
      "read_file",
      "review_read",
      "office_inspect",
      "office_read",
      "office_preview",
      "office_render",
      "office_edit",
      "connector_discover",
      "connector_call",
      "search_text",
      "code_navigate",
      "code_outline",
      "code_symbols",
      "code_map",
      "web_fetch",
      "web_search",
      "read_messages",
      "screenshot",
      "ui_tree",
      "keys",
      "image_result",
      "run_command",
      "background_command",
      "write_stdin",
      "phone_media",
      "phone_media_get",
      "phone_sms_code",
      "phone_calls",
      "phone_notifications",
    ].includes(tool)
  );
}
