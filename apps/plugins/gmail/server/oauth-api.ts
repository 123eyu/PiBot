import type { PluginSecrets } from "@pibot/plugin-sdk";
import { type createOAuthHttp, stringField } from "./oauth-http.ts";

export type OAuthApiOptions = {
  secrets: PluginSecrets;
  http: ReturnType<typeof createOAuthHttp>;
  clientId: () => Promise<string>;
  compose(args: Record<string, unknown>): Promise<Buffer>;
};

export function createOAuthApi(options: OAuthApiOptions) {
  const { secrets, http, clientId } = options;
  async function api(path: string, signal: AbortSignal, body?: unknown) {
    const refresh = await secrets.get("gmail.oauth.refresh");
    if (!refresh) throw new Error("gmail_oauth_authorization_required");
    const configuredClientId = await clientId();
    if (!configuredClientId) throw new Error("gmail_oauth_not_configured");
    const value = await http.json(
      "https://auth.pibot.space/gmail/refresh",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: configuredClientId,
          refresh_token: refresh,
        }),
      },
      signal,
    );
    // Request-local access token: no file, secret store, result or logging.
    const access = stringField(value, "access_token");
    return http.json(
      `https://gmail.googleapis.com/gmail/v1/users/me/${path}`,
      {
        headers: {
          authorization: `Bearer ${access}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
      },
      signal,
    );
  }
  return async (tool: string, args: Record<string, unknown>, signal: AbortSignal) => {
    if (tool === "list_labels") return api("labels", signal);
    if (tool === "search_messages") {
      const query = new URLSearchParams({
        q: String(args.query),
        maxResults: String(args.limit ?? 20),
      });
      if (args.pageToken) query.set("pageToken", String(args.pageToken));
      return { ...(await api(`messages?${query}`, signal)), untrusted: true };
    }
    if (tool === "read_message") {
      const message = await api(`messages/${id(args.messageId)}?format=full`, signal);
      return summarize(message);
    }
    if (tool === "read_thread") {
      const thread = await api(`threads/${id(args.threadId)}?fields=id,messages(id)`, signal);
      const messages = array(thread.messages);
      const after = args.afterMessageId
        ? messages.findIndex((row) => row.id === args.afterMessageId) + 1
        : 0;
      if (args.afterMessageId && after === 0) throw new Error("gmail_stale_cursor");
      const page = messages.slice(after, after + 10);
      const rows = [];
      for (const row of page)
        rows.push(summarize(await api(`messages/${id(row.id)}?format=full`, signal)));
      return {
        messages: rows,
        nextAfterMessageId: messages.length > after + 10 ? page.at(-1)?.id : undefined,
        untrusted: true,
      };
    }
    if (tool === "create_draft" || tool === "send_message") {
      const raw = (await options.compose(args)).toString("base64url");
      return api(
        tool === "create_draft" ? "drafts" : "messages/send",
        signal,
        tool === "create_draft" ? { message: { raw } } : { raw },
      );
    }
    if (tool === "modify_labels") {
      const add = (args.add ?? []) as string[];
      const remove = (args.remove ?? []) as string[];
      // Preserve the T9 boundary: custom labels and read status, never archive/trash/delete.
      if ([...add, ...remove].some((label) => !/^Label_[A-Za-z0-9_-]{1,100}$/.test(label)))
        throw new Error("gmail_system_label_not_allowed");
      const addLabelIds = [...add];
      const removeLabelIds = [...remove];
      if (args.read === true) removeLabelIds.push("UNREAD");
      if (args.read === false) addLabelIds.push("UNREAD");
      await api(`messages/${id(args.messageId)}/modify`, signal, { addLabelIds, removeLabelIds });
      return { updated: true };
    }
    throw new Error("gmail_tool_unavailable");
  };
}

function id(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw new Error("gmail_invalid_id");
  return encodeURIComponent(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("gmail_response_invalid");
  return value as Record<string, unknown>;
}
function array(value: unknown) {
  if (!Array.isArray(value)) throw new Error("gmail_response_invalid");
  return value.map(object);
}
function summarize(value: Record<string, unknown>) {
  const payload = object(value.payload);
  const attachments: { name: string; mimeType: string; size: number }[] = [];
  const text: string[] = [];
  let bytes = 0;
  let truncated = false;
  const visit = (part: Record<string, unknown>, depth: number) => {
    if (depth > 20) {
      truncated = true;
      return;
    }
    const body = part.body ? object(part.body) : {};
    const filename = typeof part.filename === "string" ? part.filename : "";
    if (filename || body.attachmentId) {
      attachments.push({
        name: filename.slice(0, 512),
        mimeType: String(part.mimeType ?? ""),
        size: Number(body.size ?? 0),
      });
    } else if (part.mimeType === "text/plain" && typeof body.data === "string") {
      const content = Buffer.from(body.data, "base64url");
      const available = Math.max(0, 50000 - bytes);
      text.push(content.subarray(0, available).toString("utf8"));
      bytes += Math.min(available, content.length);
      truncated ||= content.length > available;
    }
    if (part.parts) for (const child of array(part.parts)) visit(child, depth + 1);
  };
  visit(payload, 0);
  const headers = payload.headers
    ? array(payload.headers)
        .filter(
          (header) =>
            typeof header.name === "string" && /^(from|to|date|subject)$/i.test(header.name),
        )
        .slice(0, 20)
        .map((header) => ({ name: header.name, value: String(header.value ?? "").slice(0, 4096) }))
    : [];
  return {
    messageId: stringField(value, "id", 128),
    threadId: value.threadId,
    headers,
    body: text.join("\n"),
    attachments: attachments.slice(0, 100),
    truncated,
    untrusted: true,
  };
}
