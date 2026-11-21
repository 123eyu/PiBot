import { serveStdio } from "@pibot/plugin-sdk";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import { SocksClient } from "socks";
import { createOAuthRuntime } from "./oauth.ts";
import { toolDefinitions } from "./tools.ts";

let email = process.env.GMAIL_EMAIL ?? "";
const mode = process.env.GMAIL_LOGIN_MODE ?? "app_password";
let password = (process.env.GMAIL_APP_PASSWORD ?? "").replace(/ /g, "");
if (process.env.GMAIL_CREDENTIAL) {
  let value: unknown;
  try {
    value = JSON.parse(process.env.GMAIL_CREDENTIAL);
  } catch {
    throw new Error("gmail_credential_invalid");
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("email" in value) ||
    !("appPassword" in value) ||
    typeof value.email !== "string" ||
    typeof value.appPassword !== "string"
  )
    throw new Error("gmail_credential_invalid");
  email = value.email;
  password = value.appPassword.replace(/ /g, "");
}
delete process.env.GMAIL_APP_PASSWORD;
delete process.env.GMAIL_CREDENTIAL;
if (!["app_password", "oauth"].includes(mode)) throw new Error("gmail_login_mode_invalid");
// Only proxy-aware clients may dial Gmail. Missing proxy is an error, never a direct fallback.
const proxy = process.env.ALL_PROXY ?? process.env.all_proxy;
if (!proxy) throw new Error("gmail_sandbox_proxy_required");
if (mode !== "oauth" && !/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error("gmail_email_required");
if (mode === "app_password" && !/^[A-Za-z0-9]{16}$/.test(password))
  throw new Error("gmail_app_password_required");

function mail(args: Record<string, unknown>) {
  const to = String(args.to);
  if (!/^[^\s@<>;,]+@[^\s@<>;,]+$/.test(to) || /[\r\n]/.test(String(args.subject)))
    throw new Error("gmail_invalid_recipient_or_subject");
  return {
    from: email,
    to,
    subject: String(args.subject),
    text: String(args.body),
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

async function readMessage(client: ImapFlow, uid: number) {
  const row = await client.fetchOne(
    String(uid),
    { uid: true, envelope: true, bodyStructure: true },
    { uid: true },
  );
  if (!row) throw new Error("gmail_message_not_found");
  // Fetch only the text part, never the full RFC822 source (which includes attachments).
  const parts: { part: string; type: string; size?: number }[] = [];
  const visit = (node: typeof row.bodyStructure) => {
    if (!node) return;
    if (node.type === "text/plain" && node.disposition !== "attachment")
      parts.push({ part: node.part ?? "1", type: node.type, size: node.size });
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(row.bodyStructure);
  const selected = parts[0];
  let body = "";
  if (selected) {
    const download = await client.download(String(uid), selected.part, {
      uid: true,
      maxBytes: 50000,
    });
    const chunks: Buffer[] = [];
    if (!download.content) throw new Error("gmail_part_missing");
    for await (const chunk of download.content) chunks.push(Buffer.from(chunk));
    body = Buffer.concat(chunks).toString("utf8");
  }
  return {
    uid: row.uid,
    uidValidity: client.mailbox ? String(client.mailbox.uidValidity) : undefined,
    envelope: row.envelope,
    body,
    truncated: (selected?.size ?? 0) > 50000,
    bodyStructure: row.bodyStructure,
    untrusted: true,
  };
}

await serveStdio({
  id: "gmail",
  open: async ({ secrets, host, signal: lifetime }) => {
    if (mode === "oauth") email = (await secrets.get("gmail.oauth.email")) ?? email;
    const oauth =
      mode === "oauth"
        ? createOAuthRuntime({
            proxy,
            host,
            secrets,
            signal: lifetime,
            compose: async (args) => new MailComposer(mail(args)).compile().build(),
            onEmail: (value) => {
              email = value;
            },
          })
        : undefined;
    return {
      listTools: async () => ({ tools: toolDefinitions(mode === "oauth") }),
      onToolsChanged: () => () => undefined,
      callTool: async ({ tool, args, signal: requestSignal }) => {
        const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(60000)]);
        if (oauth) return oauth.call(tool, args, signal);
        const auth = { user: email, pass: password };
        const client = new ImapFlow({
          host: "imap.gmail.com",
          port: 993,
          secure: true,
          auth,
          proxy,
          logger: false,
          connectionTimeout: 15000,
          greetingTimeout: 15000,
          socketTimeout: 30000,
        });
        client.on("error", () => client.close());
        const abort = () => client.close();
        signal.addEventListener("abort", abort, { once: true });
        try {
          signal.throwIfAborted();
          if (tool === "send_message") {
            const transport = nodemailer.createTransport({
              host: "smtp.gmail.com",
              port: 465,
              secure: true,
              auth,
              proxy,
              connectionTimeout: 15000,
              greetingTimeout: 15000,
              socketTimeout: 30000,
              logger: false,
              debug: false,
            });
            transport.set("proxy_socks_module", { SocksClient });
            const cancel = () => transport.close();
            signal.addEventListener("abort", cancel, { once: true });
            try {
              return { messageId: (await transport.sendMail({ ...mail(args), signal })).messageId };
            } finally {
              signal.removeEventListener("abort", cancel);
              transport.close();
            }
          }
          await client.connect();
          if (tool === "create_draft") {
            const folders = await client.list();
            const draft = folders.find((folder) => folder.specialUse === "\\Drafts");
            if (!draft) throw new Error("gmail_drafts_unavailable");
            const content = await new MailComposer(mail(args)).compile().build();
            const result = await client.append(draft.path, content, ["\\Draft"]);
            return { created: !!result };
          }
          if (tool === "list_labels")
            return (await client.list()).map(({ path, specialUse }) => ({ path, specialUse }));
          const all = (await client.list()).find((folder) => folder.specialUse === "\\All");
          if (!all) throw new Error("gmail_all_mail_unavailable");
          const lock = await client.getMailboxLock(all.path, {
            readOnly: tool !== "modify_labels",
          });
          try {
            if (
              (tool === "modify_labels" || tool === "read_message") &&
              (!client.mailbox || String(client.mailbox.uidValidity) !== args.uidValidity)
            )
              throw new Error("gmail_stale_mailbox");
            if (tool === "modify_labels") {
              const add = (args.add ?? []) as string[];
              const remove = (args.remove ?? []) as string[];
              if (
                [...add, ...remove].some(
                  (label) =>
                    /[\\\r\n]/.test(label) ||
                    /^(inbox|trash|spam|sent|drafts|\[gmail\])/i.test(label),
                )
              )
                throw new Error("gmail_system_label_not_allowed");
              if (add.length)
                await client.messageFlagsAdd(String(args.uid), add, { uid: true, useLabels: true });
              if (remove.length)
                await client.messageFlagsRemove(String(args.uid), remove, {
                  uid: true,
                  useLabels: true,
                });
              if (typeof args.read === "boolean") {
                if (args.read)
                  await client.messageFlagsAdd(String(args.uid), ["\\Seen"], { uid: true });
                else await client.messageFlagsRemove(String(args.uid), ["\\Seen"], { uid: true });
              }
              return { updated: true };
            }
            if (tool === "search_messages" || tool === "read_thread") {
              if (tool === "read_thread" && !/^\d{1,24}$/.test(String(args.threadId)))
                throw new Error("gmail_invalid_thread_id");
              const query =
                tool === "read_thread"
                  ? `in:inbox thread:${String(args.threadId)}`
                  : String(args.query);
              const limit = Number(args.limit ?? (tool === "read_thread" ? 10 : 20));
              const found = await client.search(
                tool === "read_thread" ? { threadId: String(args.threadId) } : { gmailraw: query },
                { uid: true },
              );
              const ids = (found || [])
                .filter((uid) => uid < Number(args.beforeUid ?? Infinity))
                .sort((a, b) => b - a);
              const page = ids.slice(0, limit);
              if (tool === "read_thread") {
                const messages = [];
                for (const uid of page) messages.push(await readMessage(client, uid));
                return { messages, nextBeforeUid: ids.length > limit ? page.at(-1) : undefined };
              }
              const rows = [];
              if (page.length)
                for await (const row of client.fetch(
                  page.join(","),
                  { uid: true, envelope: true, threadId: true },
                  { uid: true },
                ))
                  rows.push({ uid: row.uid, envelope: row.envelope, threadId: row.threadId });
              return {
                uidValidity: client.mailbox ? String(client.mailbox.uidValidity) : undefined,
                messages: rows,
                nextBeforeUid: ids.length > limit ? page.at(-1) : undefined,
              };
            }
            if (tool === "read_message") return readMessage(client, Number(args.uid));
            throw new Error("gmail_tool_unavailable");
          } finally {
            lock.release();
          }
        } catch {
          signal.throwIfAborted();
          // Protocol errors can contain credentials or message text; never pass them to MCP.
          throw new Error(
            tool === "send_message"
              ? "gmail_send_status_unknown / 发送状态不明，请核对已发送邮件，不要自动重发 / Check Sent mail; do not retry automatically"
              : "gmail_request_failed / Gmail 请求失败，请检查凭据与联网设置",
          );
        } finally {
          signal.removeEventListener("abort", abort);
          client.close();
        }
      },
      // The OAuth runtime owns the pending authorization and its proxy dispatcher.
      close: async () => {
        await oauth?.close();
      },
    };
  },
});
