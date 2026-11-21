import { realpath, stat } from "node:fs/promises";
import { abortable } from "@pibot/brain/orchestration-kit";
import { type KernelMethodParams, RpcError } from "@pibot/protocol-base";
import { BotsRepo, GroupAcpRepo, transaction } from "@pibot/storage";
import type { GroupService } from "./group-service.ts";

/** ACP only projects topic folders; the ordinary group's workspace policy/members stay untouched. */
export class GroupAcpTopics {
  readonly repo: GroupAcpRepo;
  constructor(private readonly service: GroupService) {
    this.repo = new GroupAcpRepo(service.deps.db);
  }
  group(groupId: string) {
    const group = this.service.active(groupId);
    const bots = new BotsRepo(this.service.deps.db);
    if (
      !group.members.some((m) => m.botId === group.coordinatorBotId) ||
      group.members.some((m) => !bots.get(m.botId) || bots.get(m.botId)?.archivedAt)
    )
      throw new RpcError(-32602, "group_acp_unavailable");
    return group;
  }
  topic(groupId: string, topicId: string) {
    this.group(groupId);
    if (!this.service.topics.repo.isAcp(groupId, topicId))
      throw new RpcError(-32602, "group_acp_topic_required");
    const topic = this.service.topics.repo.get(groupId, topicId);
    if (topic.archivedAt) throw new RpcError(-32602, "group_acp_topic_unavailable");
    return topic;
  }
  async verifyRoots(groupId: string, topicId: string, signal: AbortSignal, cwd?: string) {
    const topic = this.topic(groupId, topicId),
      roots = this.repo.roots(topicId);
    if (
      !roots ||
      roots[0]?.id !== topic.primaryFolderId ||
      roots.length !== topic.folders.length ||
      roots.some((root) => !topic.folders.some((f) => f.id === root.id && f.path === root.path))
    )
      throw new RpcError(-32602, "group_acp_roots_changed");
    for (const root of roots) {
      const canonical = await abortable(realpath(root.path), signal);
      const info = await abortable(stat(canonical, { bigint: true }), signal);
      if (
        canonical !== root.path ||
        !info.isDirectory() ||
        String(info.dev) !== root.device ||
        String(info.ino) !== root.inode
      )
        throw new RpcError(-32602, "group_acp_roots_changed");
    }
    if (cwd && (await abortable(realpath(cwd), signal)) !== roots[0]?.path)
      throw new RpcError(-32602, "topic_folder_mismatch");
    signal.throwIfAborted();
  }
  async create(params: KernelMethodParams["groups.acp.topics.create"], signal: AbortSignal) {
    this.group(params.groupId);
    const roots = await this.service.topics.acpSelection(params.groupId, params.selection, signal);
    signal.throwIfAborted();
    // Selection yields to other topic changes. Capture the predecessor immediately before the
    // inner create, whose source guard also rejects changes before its synchronous commit.
    const previous = this.group(params.groupId);
    const created = await this.service.topics.create({
      groupId: params.groupId,
      selection: params.selection,
      inheritWorkspace: false,
    });
    try {
      signal.throwIfAborted();
      transaction(this.service.deps.db, () => {
        if (this.group(params.groupId).conversationId !== created.conversationId)
          throw new RpcError(-32602, "group_topic_stale");
        this.service.topics.repo.markAcp(params.groupId, created.conversationId);
        this.repo.setRoots(created.conversationId, roots);
        this.repo.setPreviousTopic(created.conversationId, previous.conversationId);
      });
      await this.verifyRoots(params.groupId, created.conversationId, signal);
      return { topicId: created.conversationId };
    } catch (error) {
      // Restore while our topic is still active: archiving first invalidates activeGroup().
      // A later user selection owns its projection, so compensation must leave it in place.
      if (this.service.groups.get(params.groupId)?.conversationId === created.conversationId)
        await this.service.topics
          .switch({ groupId: params.groupId, topicId: previous.conversationId })
          .catch(() => undefined);
      // Only this call's new topic; a cancelled setup never archives an existing user topic.
      await this.service.topics
        .archive(
          { groupId: params.groupId, topicId: created.conversationId },
          { requireInactive: true },
        )
        .catch(() => undefined);
      throw error;
    }
  }
  async attach(params: KernelMethodParams["groups.acp.topics.attach"], signal: AbortSignal) {
    await this.verifyRoots(params.groupId, params.topicId, signal, params.cwd);
    signal.throwIfAborted();
    const previous = this.group(params.groupId).conversationId;
    await this.service.topics.switch(params);
    try {
      await this.verifyRoots(params.groupId, params.topicId, signal, params.cwd);
      return { topicId: params.topicId };
    } catch (error) {
      // Revert only our projection, never a topic another request selected afterward.
      if (
        this.group(params.groupId).conversationId === params.topicId &&
        previous !== params.topicId
      )
        await this.service.topics.switch({ groupId: params.groupId, topicId: previous });
      throw error;
    }
  }
  async rebind(params: KernelMethodParams["groups.acp.topics.rebind"], signal: AbortSignal) {
    this.topic(params.groupId, params.topicId);
    signal.throwIfAborted();
    const previous = this.group(params.groupId).conversationId;
    await this.service.topics.switch(params);
    try {
      await this.service.topics.acpRebind(params.groupId, params.topicId, params.selection, signal);
      return null;
    } catch (error) {
      if (
        this.group(params.groupId).conversationId === params.topicId &&
        previous !== params.topicId
      )
        await this.service.topics.switch({ groupId: params.groupId, topicId: previous });
      throw error;
    }
  }
  async archive(params: KernelMethodParams["groups.acp.topics.archive"], signal: AbortSignal) {
    if (!this.service.topics.repo.isAcp(params.groupId, params.topicId))
      throw new RpcError(-32602, "group_acp_topic_required");
    const group = this.group(params.groupId);
    signal.throwIfAborted();
    // Switch restores the saved ordinary projection before archiving our topic.
    const previous = this.repo.previousTopic(params.topicId);
    if (group.conversationId === params.topicId && previous) {
      const target = this.service.topics.repo.get(params.groupId, previous);
      if (!target.archivedAt)
        await this.service.topics.switch({ groupId: params.groupId, topicId: previous });
    }
    await this.service.topics.archive(params, { requireInactive: true });
    return null;
  }
}
