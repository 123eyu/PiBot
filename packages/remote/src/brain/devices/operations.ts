import type { IsolationStatus } from "@pibot/execution";
import { runnerDeviceId, unbase64 } from "@pibot/link";
import { RpcError, RpcErrorCodes } from "@pibot/protocol";
import { transaction } from "@pibot/storage";
import { pushScope, roomScope } from "../link/identity.ts";
import type { RemoteLinkPort } from "../link/port.ts";
import type { RemoteOfflineService } from "../offline/service.ts";
import type { RemoteNotifications } from "../push/notifications.ts";
import type { RemoteResources } from "../runtime/context.ts";
import type { RemoteConnections } from "../sessions/connections.ts";

/** A per-session probe answer; never persisted, so only the two fields the row shows. */
function isolatedView(isolation: IsolationStatus | undefined) {
  if (!isolation) return {};
  return {
    isolation: {
      available: isolation.available,
      ...(isolation.reason ? { reason: isolation.reason } : {}),
    },
  };
}
export class RemoteDeviceOperations {
  constructor(
    private readonly r: RemoteResources,
    private readonly connections: RemoteConnections,
    private readonly notifications: RemoteNotifications,
    private readonly ready: () => { link: RemoteLinkPort; relay: string },
    private readonly signal: () => AbortSignal,
    private readonly offline?: RemoteOfflineService,
  ) {}
  private view(id: string) {
    const d = this.r.devices.require(id);
    const phoneData = this.connections.phoneData(id);
    return {
      ...(phoneData ? { phoneData } : {}),
      id: d.id,
      name: d.name,
      kind: d.kind,
      // A revoked runner keeps its key only to receive the deletion, not as a live target.
      ...(d.kind === "runner" && d.publicKey && !d.revokedAt
        ? { target: `runner:${runnerDeviceId(unbase64(d.publicKey, 32))}` }
        : {}),
      createdAt: d.createdAt,
      lastSeenAt: d.lastSeenAt,
      revokedAt: d.revokedAt,
      revocationPending: !!d.revokedAt && !!d.room,
      online: !d.revokedAt && this.connections.online(id),
      ...(d.kind === "runner" && !d.revokedAt
        ? {
            runnerConnection: {
              state: this.connections.runners.state(id) ?? "connecting",
              path: this.connections.runners.path(id),
            },
          }
        : {}),
      ...(d.kind === "runner" && !d.revokedAt
        ? isolatedView(this.connections.runners.isolation(id))
        : {}),
      path: this.connections.path(id),
      directFailure: this.connections.directFailure(id),
    };
  }
  list(params: Parameters<RemoteResources["devices"]["page"]>[0]) {
    const page = this.r.devices.page(params);
    return { ...page, items: page.items.map((d) => this.view(d.id)) };
  }
  async rename(id: string, name: string) {
    transaction(this.r.ctx.db, () => {
      this.r.devices.rename(id, this.r.ctx.redactor.redact(name));
      this.r.audit(id, "devices.rename", "renamed", "user");
    });
    this.r.changed();
    return this.view(id);
  }
  async revoke(id: string, removeAnyway = false) {
    const device = this.r.devices.require(id);
    if (removeAnyway && !device.revokedAt)
      throw new RpcError(RpcErrorCodes.invalidParams, "remote_device_not_revoked");
    if (device.revokedAt && !device.room) return { ok: true as const };
    if (removeAnyway) return this.removeAnyway(id);
    // The phone is told to drop its keys and offline cache while its link still exists.
    if (device.kind === "phone") this.offline?.clearNotice(id);
    transaction(this.r.ctx.db, () => {
      this.r.devices.revoke(id);
      this.r.secrets.remove(pushScope(id), "token");
      this.offline?.clear(id);
      this.r.audit(id, "devices.revoke", "revoked", "user");
    });
    // The local trust boundary is removed even if a remote revoke or cleanup must be retried.
    this.r.changed();
    const delivered = device.kind === "runner" ? await this.connections.runners.revoke(id) : true;
    // The runner layer clears the room itself once the deletion is confirmed; revoking it again
    // would only trip over the removed secret and report a revocation that is already complete.
    const settled = delivered && !this.r.devices.get(id)?.room;
    // A pending deletion keeps the runner entry alive so it can still reach the peer; closing it
    // here would strand the revocation. Everything else on this device is closed either way.
    await this.connections.close(id, { runners: delivered });
    await this.notifications.revoke(id);
    // The relay keeps no server-side revocation list, so leaving the room now would make the peer
    // unreachable before it learned about the revocation. The room is retired after delivery.
    // Only a confirmed delivery retires the room here; while the deletion is still pending the
    // room must stay joinable, otherwise the desktop itself could never reach the peer again.
    if (delivered && !settled && device.room) await this.revokeRoom(id, device.room);
    transaction(this.r.ctx.db, () => {
      if (delivered) {
        this.r.devices.clearRoom(id);
        this.r.secrets.remove(roomScope(id), "room");
      }
      // The audit states what the peer actually confirmed; a dropped notification stays pending
      // instead of claiming the runner was told.
      this.r.audit(id, "devices.revoke", delivered ? "completed" : "delivery_pending", "user");
    });
    this.r.changed();
    return { ok: true as const };
  }
  private async removeAnyway(id: string) {
    this.r.audit(id, "devices.revoke", "remove_anyway_requested", "user");
    // Drain delivery-only runner loops before destroying the credentials they could still use.
    await this.connections.close(id);
    await this.notifications.revoke(id);
    const device = this.r.devices.require(id);
    let relayPending = false;
    if (device.room) {
      try {
        await this.revokeRoom(id, device.room);
      } catch (error) {
        if (!(error instanceof RpcError) || !error.message.endsWith("revocation_pending"))
          throw error;
        // The owner explicitly accepted incomplete remote cleanup; local trust stays revoked.
        relayPending = true;
      }
    }
    transaction(this.r.ctx.db, () => {
      this.r.devices.clearRoom(id);
      this.r.secrets.remove(roomScope(id), "room");
      this.r.secrets.remove(pushScope(id), "token");
      this.offline?.clear(id);
      this.r.audit(
        id,
        "devices.revoke",
        relayPending ? "removed_with_relay_pending" : "removed_without_peer_confirmation",
        "user",
      );
    });
    this.r.changed();
    return { ok: true as const };
  }
  private async revokeRoom(id: string, room: string) {
    try {
      const secret = await this.r.secrets.get(roomScope(id), "room");
      if (!secret) throw new Error("remote_room_secret_missing");
      const { link, relay } = this.ready();
      await link.revoke({
        relayUrl: relay,
        room,
        roomSecret: secret,
        signal: AbortSignal.any([this.signal(), AbortSignal.timeout(20_000)]),
      });
    } catch {
      this.r.audit(id, "devices.revoke", "relay_revocation_pending", "user");
      throw new RpcError(
        RpcErrorCodes.unsupported,
        `remote_${this.r.devices.require(id).kind}_revocation_pending`,
      );
    }
  }
}
