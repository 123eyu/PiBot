import type { DatabaseSync } from "node:sqlite";
import {
  type InboxItemEnvelope,
  type KernelEvents,
  type KernelMethods,
  type Peer,
  RpcError,
  type SidebarEntry,
} from "@pibot/protocol-base";
import {
  BackgroundTaskHealthRepo,
  BotsRepo,
  ConversationsRepo,
  InboxRepo,
  type InboxSource,
  SearchRepo,
  SidebarRepo,
} from "@pibot/storage";
import type { z } from "zod";
import { businessResult } from "../../core/business-errors.ts";
import type { KernelRegisterRpc } from "../../core/business-rpc.ts";
import type { ChatService } from "./chat.ts";

export function registerNavigationRpc(
  handle: KernelRegisterRpc,
  db: DatabaseSync,
  peer: Peer<typeof KernelMethods, typeof KernelEvents>,
  chat: ChatService,
  inboxSources: readonly InboxSource[] = [],
  inboxItemSchema?: z.ZodType<InboxItemEnvelope>,
) {
  const sidebar = new SidebarRepo(db),
    inbox = new InboxRepo(db, inboxSources, inboxItemSchema),
    search = new SearchRepo(db);
  const changed = (conversationKey?: string) =>
    peer.emit("sidebar.changed", conversationKey ? { conversationKey } : {});
  handle("sidebar.list", async ({ includeHidden, ...page }) => {
    // The main Bot is always listed, even before its first message (a fresh install showed an
    // empty sidebar next to an open Pi chat). Creating the row never un-hides it.
    const main = new BotsRepo(db).getMain();
    if (main && !page.before) sidebar.ensure(`dm:${main.id}`);
    return {
      entries: sidebar.list(page, includeHidden),
      archivedCount: sidebar.archivedCount(),
      groups: sidebar.groups({ limit: 200 }),
    };
  });
  handle("sidebar.update", async ({ conversationKey, ...patch }) => {
    if (patch.groupId && !sidebar.group(patch.groupId))
      throw new RpcError(-32602, "Unknown sidebar group");
    const entry = businessResult(() => sidebar.update(conversationKey, patch));
    changed(conversationKey);
    return entry;
  });
  // Opening an already read conversation changes nothing anyone displays (lastReadAt is not shown).
  // Announcing it anyway made every listener of this key re-read on each switch: the sidebar's
  // previews, the opened chat's history, folders and topic title (2026-11-15).
  const visible = (before: SidebarEntry | undefined, after: SidebarEntry) =>
    !before || before.unread !== after.unread || before.hiddenAt !== after.hiddenAt;
  handle("sidebar.open", async ({ conversationKey }) => {
    const before = sidebar.get(conversationKey);
    const entry = businessResult(() => sidebar.open(conversationKey));
    const kind = conversationKey.startsWith("dm:") ? "dm" : "group",
      id = conversationKey.slice(conversationKey.indexOf(":") + 1);
    const conversation =
      kind === "dm"
        ? new ConversationsRepo(db).currentDmIfPresent(id)
        : new ConversationsRepo(db).forGroup(id);
    if (conversation) chat.openConversation(conversation.id);
    if (visible(before, entry)) changed(conversationKey);
    return entry;
  });
  handle("sidebar.read", async ({ conversationKey }) => {
    const before = sidebar.get(conversationKey);
    const entry = businessResult(() => sidebar.read(conversationKey));
    if (visible(before, entry)) changed(conversationKey);
    return entry;
  });
  handle("sidebar.groups.list", async (page) => sidebar.groups(page));
  handle("sidebar.groups.create", async ({ name }) => {
    const group = sidebar.createGroup(name);
    changed();
    return group;
  });
  handle("sidebar.groups.update", async ({ id, ...patch }) => {
    const group = sidebar.updateGroup(id, patch);
    if (!group) throw new RpcError(-32602, "Unknown sidebar group");
    changed();
    return group;
  });
  handle("sidebar.groups.remove", async ({ id }) => {
    if (!sidebar.removeGroup(id)) throw new RpcError(-32602, "Unknown sidebar group");
    changed();
    return { ok: true };
  });
  handle("inbox.list", async (page) => inbox.list(page));
  handle("inbox.counts", async () => inbox.counts());
  handle("inbox.dismissBackgroundTask", async (failure) => {
    new BackgroundTaskHealthRepo(db, () => peer.emit("inbox.changed", {})).dismiss(failure);
    return { ok: true as const };
  });
  handle("search.query", async (params) => search.query(params));
}
