import { randomBytes } from "node:crypto";
import {
  base64url,
  destroyEndpoint,
  endpointKeys,
  runnerDeviceId,
  signPhoneControl,
  unbase64,
} from "@pibot/link";
import type { EndpointRegistrySource } from "@pibot/protocol-base";
import {
  PHONE_CONTROL_TTL_MS,
  type PhoneControlGrant,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol-base";
import { RunnerControlRepo } from "../../store/runner-control.ts";
import type { EndpointIdentity } from "../link/port.ts";
import type { RemoteResources } from "../runtime/context.ts";

export class PhoneAuthorizations {
  readonly repo: RunnerControlRepo;
  private tail: Promise<unknown> = Promise.resolve();
  private unsupported = new Set<string>();
  constructor(
    private readonly r: RemoteResources,
    private readonly deps: {
      signal(): AbortSignal;
      identity(): Promise<EndpointIdentity>;
      send(id: string, grants: PhoneControlGrant[], signal: AbortSignal): Promise<void>;
      changed(phone: string): void;
    },
  ) {
    this.repo = new RunnerControlRepo(r.ctx.db);
  }
  private devices() {
    const result = [];
    let after: string | undefined;
    do {
      const page = this.r.devices.page({ after, limit: 100, includeRevoked: true });
      result.push(...page.items);
      after = page.nextAfter ?? undefined;
      if (result.length > 1000) throw new RpcError(RpcErrorCodes.busy, "device_capacity");
    } while (after);
    return result;
  }
  private async grant(
    phoneId: string,
    runnerId: string,
    force = false,
  ): Promise<PhoneControlGrant | undefined> {
    const phone = this.r.devices.require(phoneId);
    const runner = this.r.devices.require(runnerId);
    const saved = this.repo.get(phoneId, runnerId);
    const enabled = saved.enabled && !phone.revokedAt && !runner.revokedAt;
    const registry = this.r.ctx.ports.get<EndpointRegistrySource>("endpoints.registry");
    const capabilities = (registry?.enabled(runnerId) ?? [])
      .filter((id): id is "runner.exec" | "runner.files" | "runner.background" =>
        ["runner.exec", "runner.files", "runner.background"].includes(id),
      )
      .sort();
    const direct = this.r.settings.get().direct;
    const stunUrl = direct.mode === "stun" ? direct.stunUrl : null;
    const previous = saved.grant;
    if (
      previous &&
      !force &&
      previous.body.enabled === enabled &&
      previous.body.stunUrl === stunUrl &&
      JSON.stringify(previous.body.capabilities) === JSON.stringify(capabilities) &&
      (!enabled || previous.body.expiresAt - Date.now() > 6 * 60 * 60_000)
    )
      return previous;
    const phoneKey = phone.publicKey ?? previous?.body.phone;
    const runnerKey = runner.publicKey ?? previous?.body.runner;
    if (!phoneKey || !runnerKey) return undefined;
    const identity = await this.deps.identity();
    const keys = endpointKeys(unbase64(identity.privateKey, 32));
    try {
      if (base64url(keys.signingPublic) !== identity.publicKey)
        throw new Error("identity_mismatch");
      const now = Date.now();
      const grant = signPhoneControl(keys, {
        version: 1,
        issuer: identity.publicKey,
        phone: phoneKey,
        runner: runnerKey,
        runnerId: runnerDeviceId(unbase64(runnerKey, 32)),
        revision: saved.revision + 1,
        rotation: base64url(randomBytes(32)),
        issuedAt: now,
        expiresAt: now + PHONE_CONTROL_TTL_MS,
        enabled,
        capabilities,
        stunUrl,
      });
      // Device trust may have changed while the key store was being read.
      if (
        enabled &&
        (this.r.devices.require(phoneId).revokedAt || this.r.devices.require(runnerId).revokedAt)
      )
        return this.grant(phoneId, runnerId, true);
      this.repo.save(phoneId, runnerId, grant);
      this.r.audit(phoneId, "remote.runnerControl", enabled ? "issued" : "revoked", "automatic");
      this.deps.changed(phoneId);
      return grant;
    } finally {
      destroyEndpoint(keys);
    }
  }
  private serialize<T>(work: () => Promise<T>) {
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }
  settled() {
    return this.tail;
  }
  refresh(signal: AbortSignal) {
    return this.serialize(async () => {
      const devices = this.devices();
      for (const runner of devices.filter((d) => d.kind === "runner")) {
        const phoneIds = new Set(this.repo.forRunner(runner.id));
        if (!runner.revokedAt)
          for (const phone of devices.filter((d) => d.kind === "phone" && !d.revokedAt))
            phoneIds.add(phone.id);
        for (const phoneId of phoneIds) {
          signal.throwIfAborted();
          const grant = await this.grant(phoneId, runner.id);
          if (!grant) continue;
          try {
            await this.deps.send(runner.id, [grant], signal);
            const before = this.repo.get(phoneId, runner.id).delivered;
            this.repo.delivered(phoneId, runner.id, grant.body.revision);
            if (before !== grant.body.revision) {
              this.deps.changed(phoneId);
              this.r.changed();
            }
            this.unsupported.delete(runner.id);
          } catch (error) {
            if (signal.aborted) throw error;
            if (error instanceof RpcError && error.code === RpcErrorCodes.methodNotFound)
              this.unsupported.add(runner.id);
            // The signed revision stays pending for the next authenticated session.
          }
        }
      }
    });
  }
  async view(phoneId: string | undefined, after?: string, runnerDeviceId?: string) {
    this.r.devices.require((phoneId ?? runnerDeviceId) as string);
    const page = this.r.devices.page({ after, limit: 100, includeRevoked: true });
    return {
      items: page.items
        .filter((d) => d.kind === (phoneId ? "runner" : "phone"))
        .map((device) => {
          const runner = phoneId ? device : this.r.devices.require(runnerDeviceId as string);
          const phone = phoneId ? this.r.devices.require(phoneId) : device;
          const saved = this.repo.get(phone.id, runner.id);
          const b = saved.grant?.body;
          const pending = !!b && saved.delivered !== b.revision && b.expiresAt > Date.now();
          const effective = saved.enabled && !runner.revokedAt && !phone.revokedAt;
          return {
            runnerDeviceId: runner.id,
            phoneId: phone.id,
            editable: !phone.revokedAt && !runner.revokedAt,
            name: device.name,
            enabled: saved.enabled && !runner.revokedAt && !phone.revokedAt,
            revision: saved.revision,
            expiresAt: b?.expiresAt ?? null,
            state: (!effective
              ? b && b.expiresAt > Date.now() && (b.enabled || pending)
                ? "revoke_pending"
                : "off"
              : this.unsupported.has(runner.id)
                ? "unsupported"
                : pending || !b || b.expiresAt <= Date.now()
                  ? "pending"
                  : "ready") as "revoke_pending" | "off" | "unsupported" | "pending" | "ready",
            revoked: !!(runner.revokedAt || phone.revokedAt),
          };
        })
        // Maintainers 2026-11-13: list only paired devices. A revoked one disappears at once; a
        // revocation not yet delivered keeps retrying (or expires in 24 h) without a row.
        .filter((item) => !item.revoked)
        .map(({ revoked: _revoked, ...item }) => item),
      nextAfter: page.nextAfter,
    };
  }
  set(phoneId: string, runnerId: string, enabled: boolean, expected: number, signal: AbortSignal) {
    signal = AbortSignal.any([signal, this.deps.signal()]);
    return this.serialize(async () => {
      if (
        this.r.devices.active(phoneId).kind !== "phone" ||
        this.r.devices.active(runnerId).kind !== "runner"
      )
        throw new RpcError(RpcErrorCodes.invalidParams, "device_kind_invalid");
      signal.throwIfAborted();
      this.repo.switch(phoneId, runnerId, enabled, expected);
      this.r.audit(phoneId, "remote.runnerControl.set", enabled ? "enabled" : "revoked", "user");
      const grant = await this.grant(phoneId, runnerId, true);
      this.deps.changed(phoneId);
      if (grant)
        try {
          await this.deps.send(runnerId, [grant], signal);
          this.repo.delivered(phoneId, runnerId, grant.body.revision);
          this.deps.changed(phoneId);
          this.r.changed();
        } catch (error) {
          if (signal.aborted) throw error;
          if (error instanceof RpcError && error.code === RpcErrorCodes.methodNotFound)
            this.unsupported.add(runnerId);
        }
      return { ok: true as const };
    });
  }
  async pull(phoneId: string, after?: string) {
    this.r.devices.active(phoneId);
    const page = this.r.devices.page({ after, limit: 100 });
    const grants: PhoneControlGrant[] = [];
    for (const runner of page.items.filter((d) => d.kind === "runner")) {
      const saved = this.repo.get(phoneId, runner.id);
      if (
        saved.grant &&
        (!saved.grant.body.enabled || (saved.enabled && saved.delivered === saved.revision))
      )
        grants.push(saved.grant);
    }
    return { grants, nextAfter: page.nextAfter };
  }
}
