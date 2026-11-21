import type { DatabaseSync } from "node:sqlite";
import {
  createNetworkFetch,
  isProxyAuthenticationFailure,
  isProxyUnavailable,
  type NetworkProxy,
  ProxyCredentialsError,
} from "@pibot/execution";
import {
  type KernelMethodParams,
  type KernelMethodResults,
  NetworkProxyConfigSchema,
  ProxyAddressSchema,
  RpcError,
} from "@pibot/protocol-base";
import type { Redactor, SecretCipher } from "@pibot/secrets";
import { NetworkProxyRepo, SecretStore } from "@pibot/storage";
import { abortable } from "../../core/abort.ts";

export class NetworkProxyService {
  readonly transport = createNetworkFetch(() => this.proxy());
  private readonly repo: NetworkProxyRepo;
  private readonly secrets: SecretStore;
  private url?: string;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly shutdown = new AbortController();
  constructor(
    db: DatabaseSync,
    private readonly cipher: SecretCipher,
    private readonly redactor: Redactor,
    private readonly changed: (value: KernelMethodResults["network.getConfig"]) => void,
    private readonly audit: (
      action: "enabled" | "disabled" | "updated",
      address: string | null,
    ) => void,
  ) {
    this.repo = new NetworkProxyRepo(db);
    this.secrets = new SecretStore(db, cipher, redactor);
  }
  private async readCredential(address: string | null) {
    const value = await this.secrets.get("network_proxy", "url");
    if (!value || !ProxyAddressSchema.safeParse(value).success) throw new ProxyCredentialsError();
    const url = new URL(value);
    url.username = "";
    url.password = "";
    if (url.href !== address) throw new ProxyCredentialsError();
    this.recordCredentials(value);
    return value;
  }
  async initialize(parent = AbortSignal.timeout(20_000)) {
    const config = this.repo.get();
    if (config.hasCredentials && config.enabled) {
      const pending = this.readCredential(config.address);
      this.tail = pending.catch(() => undefined);
      try {
        this.url = await abortable(pending, AbortSignal.any([parent, this.shutdown.signal]));
      } catch {
        // Keep settings usable for recovery; proxy() fails closed, and stop drains the keyring owner.
        this.url = undefined;
      }
    } else this.url = config.hasCredentials ? undefined : (config.address ?? undefined);
  }
  private recordCredentials(value: string) {
    this.redactor.add(value);
    const auth = new URL(value);
    const user = decodeURIComponent(auth.username);
    const password = decodeURIComponent(auth.password);
    // Only URI/Basic forms leave this module; common account words must not corrupt public RPC identifiers.
    this.redactor.add(`Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`);
  }
  get() {
    return this.repo.get();
  }
  proxy(): NetworkProxy | undefined {
    if (!this.get().enabled) return undefined;
    if (!this.url) throw new ProxyCredentialsError();
    return { url: this.url };
  }
  set(input: KernelMethodParams["network.setConfig"], parent: AbortSignal) {
    const signal = AbortSignal.any([parent, this.shutdown.signal]);
    const work = this.tail.then(async () => {
      signal.throwIfAborted();
      const old = this.get();
      const parsed = input.address ? new URL(input.address) : undefined;
      const hasNewCredentials = !!(parsed?.username || parsed?.password);
      const full = parsed?.href;
      if (parsed) {
        parsed.username = "";
        parsed.password = "";
      }
      const address = input.address === null ? null : (parsed?.href ?? old.address);
      if (input.enabled && !address) throw new RpcError(-32602, "proxy_address_required");
      const preserve =
        !hasNewCredentials &&
        !input.clearCredentials &&
        address === old.address &&
        old.hasCredentials;
      const value = NetworkProxyConfigSchema.parse({
        enabled: input.enabled,
        address,
        hasCredentials: hasNewCredentials || preserve,
      });
      if (!hasNewCredentials && JSON.stringify(value) === JSON.stringify(old)) {
        // Retrying an unchanged setting can still recover an unavailable keyring session.
        const restored =
          preserve && input.enabled && !this.url ? await this.readCredential(address) : this.url;
        signal.throwIfAborted();
        this.url = restored;
        return old;
      }
      let encrypted: Uint8Array | null | undefined = preserve ? undefined : null;
      if (hasNewCredentials && full) {
        if (!(await this.cipher.isAvailable())) throw new Error("Secret encryption unavailable");
        encrypted = await this.cipher.encrypt(full);
        this.recordCredentials(full);
      }
      const restored =
        preserve && input.enabled && !this.url ? await this.readCredential(address) : this.url;
      signal.throwIfAborted();
      this.repo.save(value, encrypted, () =>
        this.audit(
          old.enabled !== value.enabled ? (value.enabled ? "enabled" : "disabled") : "updated",
          address,
        ),
      );
      this.url = hasNewCredentials ? full : preserve ? restored : (address ?? undefined);
      this.changed(value);
      return value;
    });
    this.tail = work.catch(() => {
      /* A failed save cannot poison future settings writes. */
    });
    return abortable(work, signal);
  }
  async test(parent: AbortSignal): Promise<KernelMethodResults["network.test"]> {
    const config = this.get();
    if (!config.enabled) return { ok: false, reason: "disabled", address: config.address };
    const signal = AbortSignal.any([parent, this.shutdown.signal, AbortSignal.timeout(20_000)]);
    try {
      const response = await this.transport.fetch("https://example.com/", {
        signal,
        redirect: "error",
        method: "HEAD",
      });
      await response.body?.cancel();
      return {
        ok: response.ok,
        reason: response.ok ? "connected" : "destination_unavailable",
        address: config.address,
      };
    } catch (error) {
      return {
        ok: false,
        reason: isProxyAuthenticationFailure(error)
          ? "proxy_auth_failed"
          : error instanceof ProxyCredentialsError
            ? "credentials_unavailable"
            : isProxyUnavailable(error)
              ? "proxy_unavailable"
              : signal.aborted
                ? "timeout"
                : "destination_unavailable",
        address: config.address,
      };
    }
  }
  cancel() {
    this.shutdown.abort();
  }
  async stop() {
    this.cancel();
    await this.tail;
    await this.transport.stop();
  }
}
