import { randomUUID } from "node:crypto";
import { AuditRepo, BotsRepo } from "@pibot/storage";
import { z } from "zod";
import { pushScope, roomScope } from "../link/identity.ts";
import type { RemoteLinkPort } from "../link/port.ts";
import type { RemoteResources } from "../runtime/context.ts";

const Saved = z.object({
  token: z.string(),
  language: z.enum(["zh", "en"]),
  wake: z.literal(true),
});
/** Connection preparation only. The authenticated gateway still enforces every data grant. */
export class PhoneWake {
  private attempts = new Map<string, number[]>();
  constructor(private readonly r: RemoteResources) {}
  async send(id: string, link: RemoteLinkPort, relayUrl: string, signal: AbortSignal) {
    const device = this.r.devices.active(id);
    const saved = await this.r.secrets.get(pushScope(id), "token");
    const parsed = Saved.safeParse(saved ? JSON.parse(saved) : undefined);
    if (device.kind !== "phone" || !device.room || !parsed.success) return false;
    const roomSecret = await this.r.secrets.get(roomScope(id), "room");
    const current = await this.r.secrets.get(pushScope(id), "token");
    signal.throwIfAborted();
    if (current !== saved || !this.r.devices.active(id).pushToken) return false;
    if (!roomSecret) return false;
    const times = (this.attempts.get(id) ?? []).filter((at) => Date.now() - at < 60_000);
    if (times.length >= 3) return false;
    times.push(Date.now());
    this.attempts.set(id, times);
    const audit = (reasonCode: string) =>
      new AuditRepo(this.r.ctx.db, this.r.ctx.redactor).append({
        botId: new BotsRepo(this.r.ctx.db).getMain()?.id ?? "",
        kind: "phone.wake",
        summary: "Phone wake / 唤醒手机",
        detail: { deviceId: id, reasonCode },
      });
    try {
      await link.push({
        relayUrl,
        room: device.room,
        roomSecret,
        token: parsed.data.token,
        language: parsed.data.language,
        kind: "wake",
        route: { id: randomUUID(), expires: String(Date.now() + 30_000) },
        signal,
      });
      audit("sent");
      return true;
    } catch {
      audit(signal.aborted ? "cancelled" : "failed");
      return false;
    }
  }
}
