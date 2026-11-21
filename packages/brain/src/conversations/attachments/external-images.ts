import { createHash } from "node:crypto";
import { ExecError, isProxyFailure } from "@pibot/execution";
import {
  IMAGE_LIMIT,
  type ImageContent,
  ImageContentSchema,
  KernelHostMethods,
  type KernelMethodParams,
  type KernelMethodResults,
  RpcError,
} from "@pibot/protocol-base";
import { BotsRepo, ConversationsRepo, MessagesRepo } from "@pibot/storage";
import { runPermissions } from "../../core/run-permissions.ts";
import type { LocalService } from "../../local-service.ts";
import { checkedImage } from "./attachment-files.ts";

export type ImageDownload = (input: {
  url: string;
  signal: AbortSignal;
  allowDomain(domain: string, signal: AbortSignal, url: string): Promise<boolean>;
}) => Promise<{ data: Buffer; mimeType: string }>;
type Target = KernelMethodParams["chat.externalImageStatus"];
type Result = KernelMethodResults["chat.loadExternalImage"];

/** User clicks consent to one fetch, never to persistent grants or automatic future requests. */
export class ExternalImages {
  private readonly active = new Map<string, { abort: AbortController; done: Promise<Result> }>();
  isIdle() {
    return this.active.size === 0;
  }
  private readonly cancelled = new Map<string, number>();
  private readonly cache = new Map<
    string,
    { image: ImageContent; expires: number; size: number }
  >();
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(
    private readonly local: LocalService,
    private readonly download?: ImageDownload,
  ) {
    this.timer = setInterval(() => this.prune(), 30000);
    this.timer.unref();
  }
  private prune() {
    for (const [key, item] of this.cache) if (item.expires <= Date.now()) this.cache.delete(key);
    for (const [key, expiry] of this.cancelled)
      if (expiry <= Date.now()) this.cancelled.delete(key);
  }
  private identity(target: Target) {
    const { db } = this.local.deps;
    const bot = new BotsRepo(db).get(target.botId);
    const message = new MessagesRepo(db).get(target.messageId);
    const url = new URL(target.url);
    if (
      !bot ||
      bot.archivedAt ||
      message?.role !== "assistant" ||
      message.botId !== bot.id ||
      !message.content.includes(target.url) ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new RpcError(-32602, "Image source unavailable");
    url.hash = "";
    return url;
  }
  private settings(target: Target) {
    const message = new MessagesRepo(this.local.deps.db).get(target.messageId);
    const conversation = message
      ? new ConversationsRepo(this.local.deps.db).get(message.conversationId)
      : undefined;
    if (!conversation || conversation.archivedAt)
      throw new RpcError(-32602, "Image source unavailable");
    return runPermissions(this.local, {
      botId: target.botId,
      conversationId: conversation.id,
      ...(conversation.groupId ? { groupId: conversation.groupId } : {}),
    });
  }
  private async allowed(target: Target, signal: AbortSignal) {
    this.identity(target);
    const policy = await this.local.getPolicy(signal);
    const result = await policy.evaluate({
      botId: target.botId,
      request: { category: "web", url: target.url },
      settings: this.settings(target),
      grants: [],
      workplace: { home: this.local.deps.dataDir, currentId: "home", folders: [] },
      signal,
    });
    signal.throwIfAborted();
    return result.decision !== "deny";
  }
  async status(target: Target) {
    return {
      allowed: await this.allowed(
        target,
        AbortSignal.any([this.local.shutdown.signal, AbortSignal.timeout(10000)]),
      ),
    };
  }
  load(params: KernelMethodParams["chat.loadExternalImage"]): Promise<Result> {
    this.prune();
    if (this.cancelled.has(params.requestId)) return Promise.resolve({ status: "cancelled" });
    if (this.active.has(params.requestId) || this.active.size >= 8)
      throw new RpcError(-32011, "Image request busy");
    this.local.shutdown.signal.throwIfAborted();
    const abort = new AbortController();
    const done = this.fetch(
      params,
      AbortSignal.any([abort.signal, this.local.shutdown.signal, AbortSignal.timeout(25000)]),
    );
    this.active.set(params.requestId, { abort, done });
    void done
      .finally(() => this.active.delete(params.requestId))
      .catch(() => {
        /* RPC owns the failure. */
      });
    return done;
  }
  cancel(requestId: string) {
    this.active.get(requestId)?.abort.abort();
    this.prune();
    if (this.cancelled.size < 128) this.cancelled.set(requestId, Date.now() + 30000);
    return { ok: true as const };
  }
  private async fetch(
    params: KernelMethodParams["chat.loadExternalImage"],
    signal: AbortSignal,
  ): Promise<Result> {
    let stage = "authorize";
    try {
      const url = this.identity(params);
      if (!(await this.allowed(params, signal))) return { status: "denied" };
      if (!this.download || !this.local.deps.host.attachments) return { status: "unsupported" };
      const snapshot = JSON.stringify(this.settings(params));
      const key = createHash("sha256")
        .update(JSON.stringify([params.botId, params.messageId, params.url, snapshot]))
        .digest("hex");
      const cached = this.cache.get(key);
      if (cached) return { status: "loaded", image: cached.image };
      stage = "download";
      const result = await this.download({
        url: url.href,
        signal,
        allowDomain: async (_domain, inner, address) =>
          address === url.href && (await this.allowed({ ...params, url: params.url }, inner)),
      });
      signal.throwIfAborted();
      if (result.data.length > IMAGE_LIMIT) return { status: "too_large" };
      const parsed = ImageContentSchema.safeParse({
        type: "image",
        data: result.data.toString("base64"),
        mimeType: result.mimeType,
      });
      if (!parsed.success) return { status: "not_image" };
      stage = "convert";
      const input = parsed.data;
      checkedImage(input.data, input.mimeType);
      const converted = KernelHostMethods["host.attachments.image"].result.parse(
        await this.local.deps.host.attachments.image(input, signal),
      );
      checkedImage(converted.image.data, converted.image.mimeType);
      signal.throwIfAborted();
      this.identity(params);
      if (
        snapshot !== JSON.stringify(this.settings(params)) ||
        !(await this.allowed(params, signal))
      )
        return { status: "denied" };
      stage = "commit";
      this.local.approvals.audit.append({
        botId: params.botId,
        kind: "image.loaded",
        summary: "Loaded an external image / 加载了外部图片",
        detail: {
          target: this.local.deps.redactor.redact(url.hostname),
          category: "web",
          actor: "user",
        },
      });
      const size = converted.image.data.length * 2;
      this.prune();
      while (
        this.cache.size &&
        (this.cache.size >= 32 ||
          [...this.cache.values()].reduce((total, item) => total + item.size, 0) + size >
            40 * 1024 * 1024)
      )
        this.cache.delete(this.cache.keys().next().value as string);
      this.cache.set(key, { image: converted.image, expires: Date.now() + 300000, size });
      return { status: "loaded", image: converted.image };
    } catch (error) {
      if (signal.aborted) return { status: "cancelled" };
      if (stage === "download" && isProxyFailure(error)) return { status: "network" };
      if (
        stage === "download" &&
        error instanceof ExecError &&
        error.reason === "response_too_large"
      )
        return { status: "too_large" };
      if (
        stage === "download" &&
        error instanceof ExecError &&
        error.reason === "unsupported_content_type"
      )
        return { status: "not_image" };
      if (stage === "download" && error instanceof ExecError && error.code === "web_blocked")
        return { status: "denied" };
      if (stage === "download" && error instanceof ExecError && error.code === "web_failed")
        return { status: "network" };
      if (
        stage === "convert" &&
        error instanceof RpcError &&
        (error.code === -32014 || error.code === -32016)
      )
        return { status: "not_image" };
      if (error instanceof RpcError && error.code === -32602) throw error;
      this.local.deps.logger.error(
        JSON.stringify({
          module: "external-images",
          event: "internal-error",
          stage,
          botId: params.botId,
          messageId: params.messageId,
          requestId: params.requestId,
        }),
      );
      throw new RpcError(-32603, "External image internal failure");
    }
  }
  async stop() {
    clearInterval(this.timer);
    for (const item of this.active.values()) item.abort.abort();
    await Promise.allSettled([...this.active.values()].map((item) => item.done));
    this.cache.clear();
    this.cancelled.clear();
  }
}
