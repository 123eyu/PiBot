import { transaction } from "@pibot/storage";
import { z } from "zod";
import { pushScope, roomScope } from "../link/identity.ts";
import type { RemoteLinkPort } from "../link/port.ts";
import type { RemoteKernelEvent } from "../rpc/port.ts";
import type { RemoteResources } from "../runtime/context.ts";

const PushSchema = z.strictObject({
  token: z.string().max(256),
  language: z.enum(["zh", "en"]),
  wake: z.boolean().optional(),
});
export class RemoteNotifications {
  private tasks = new Set<Promise<void>>();
  private owners = new Map<Promise<void>, string>();
  private controllers = new Map<string, AbortController>();
  private seen = new Set<string>();
  constructor(
    private readonly r: RemoteResources,
    private readonly foreground: (id: string) => boolean,
  ) {}
  publish(event: RemoteKernelEvent, link: RemoteLinkPort, relayUrl: string, signal: AbortSignal) {
    const payload = event.payload as Record<string, unknown>;
    const kind =
      event.method === "approval.requested"
        ? "approval"
        : event.method === "chat.done"
          ? "run_done"
          : event.method === "chat.error"
            ? "run_failed"
            : undefined;
    // A run the person stopped themselves is not news.
    if (!kind || (kind === "run_failed" && payload.code === "aborted")) return;
    const routeId = kind === "approval" ? payload.id : payload.runId;
    if (typeof routeId !== "string" || signal.aborted) return;
    // The phone keys its own in-app notifications the same way (apps/mobile/src/push/decide.ts),
    // so a push and a local notice for one event are recognized as the same event.
    const key = `${kind}:${routeId}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    while (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value as string);
    for (const device of this.r.devices.page({ limit: 100 }).items) {
      if (
        !device.pushToken ||
        (kind !== "approval" && this.foreground(device.id)) ||
        this.tasks.size >= 32
      )
        continue;
      const controller = this.controllers.get(device.id) ?? new AbortController();
      this.controllers.set(device.id, controller);
      const task = this.send(
        device.id,
        kind,
        routeId,
        key,
        link,
        relayUrl,
        AbortSignal.any([signal, controller.signal]),
      );
      this.tasks.add(task);
      this.owners.set(task, device.id);
      void task.finally(() => {
        this.tasks.delete(task);
        this.owners.delete(task);
      });
    }
  }
  private async send(
    id: string,
    kind: "approval" | "run_done" | "run_failed",
    routeId: string,
    eventId: string,
    link: RemoteLinkPort,
    relayUrl: string,
    signal: AbortSignal,
  ) {
    let token: string | undefined;
    try {
      const [saved, roomSecret] = await Promise.all([
        this.r.secrets.get(pushScope(id), "token"),
        this.r.secrets.get(roomScope(id), "room"),
      ]);
      signal.throwIfAborted();
      const device = this.r.devices.active(id);
      if (!saved || !roomSecret || !device.room) return;
      const push = PushSchema.parse(JSON.parse(saved));
      token = push.token;
      await link.push({
        relayUrl,
        room: device.room,
        roomSecret,
        token: push.token,
        kind,
        // Sealed with the room key: only this phone can read which event it is.
        route: { eventId, [kind === "approval" ? "approvalId" : "runId"]: routeId },
        language: push.language,
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      });
      this.r.audit(id, "remote.push", "sent", "automatic");
    } catch (error) {
      if (signal.aborted) return;
      if (token && error instanceof Error && error.message === "remote_push_unregistered")
        await this.forgetToken(id, token).catch(() =>
          this.r.ctx.logger.warn("Remote push token cleanup unavailable"),
        );
      else this.r.ctx.logger.warn("Remote push unavailable");
    }
  }
  /**
   * Expo answered DeviceNotRegistered (app removed, or the token was replaced): stop pushing to it.
   * Only that exact token is cleared, so a newer one the phone sent meanwhile survives.
   */
  private async forgetToken(id: string, token: string) {
    const saved = await this.r.secrets.get(pushScope(id), "token");
    const current = saved ? PushSchema.safeParse(JSON.parse(saved)) : undefined;
    if (!current?.success || current.data.token !== token) return;
    transaction(this.r.ctx.db, () => {
      this.r.secrets.remove(pushScope(id), "token");
      this.r.devices.pushReference(id, null);
    });
    this.r.audit(id, "remote.push", "token_unregistered", "automatic");
    this.r.ctx.logger.info("Remote push token no longer registered; cleared");
  }
  async settled() {
    await Promise.allSettled([...this.tasks]);
  }
  async revoke(id: string) {
    this.controllers.get(id)?.abort();
    await Promise.allSettled(
      [...this.owners].filter(([, owner]) => owner === id).map(([task]) => task),
    );
    this.controllers.delete(id);
  }
  busy() {
    return this.tasks.size > 0;
  }
}
