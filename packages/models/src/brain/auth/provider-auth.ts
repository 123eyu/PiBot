import type { DatabaseSync } from "node:sqlite";
import type { AgentAuthPorts, AgentErrorCode, AgentRuntime, CloudMaterial } from "@pibot/agent";
import { chatGPTSignInAvailability, chatGPTSignInFailure, mapAgentError } from "@pibot/agent";
import { cloudScope, EncryptedAuth, registerSecretLeaves } from "@pibot/brain/kit";
import {
  type AuditAuthEvent,
  CHATGPT_PLAN_PROVIDERS,
  type ChatGPTSignIn,
  type CloudConfig,
  CloudConfigSchema,
  isChatGPTPlanProvider,
  type LoginStep,
  type MethodParams,
  type ProviderAuthState,
  RpcError,
} from "@pibot/models-contract/full";
import type { Redactor, SecretCipher } from "@pibot/secrets";
import { z } from "zod";
import type { ProviderStore } from "../catalog/providers.ts";
import { chatgptHostId } from "./chatgpt-host.ts";
import { prepareCloud } from "./cloud-credentials.ts";
import { LoginFlow } from "./provider-login.ts";

const materialSchema = z.strictObject({
  providerId: z.string(),
  env: z.record(z.string(), z.string()),
  apiKey: z.string().optional(),
  googleCredentials: z.record(z.string(), z.string()).optional(),
});
// The only model OAuth left is the ChatGPT plan: the official sign-in and, since
// 2026-11-15, pi's legacy Codex login, each on its own provider id.

export interface ProviderAuthHooks {
  stateChanged?(state: ProviderAuthState): void;
  stepChanged?(step: LoginStep): void;
  openExternal?(url: string, signal: AbortSignal): Promise<void>;
  audit?(id: string, event: AuditAuthEvent): void;
  refreshFailed?(providerId: string, code: AgentErrorCode): void;
  planRequest?(route: { api: string; host: string; failure?: string }): void;
}

function failureState(error: unknown): NonNullable<ProviderAuthState["error"]> {
  const failure = chatGPTSignInFailure(error);
  if (failure === "account_mismatch" || failure === "verification_failed") return failure;
  if (failure === "authorization_denied") return "cancelled";
  return mapAgentError(error) === "network" ? "network" : "auth_failed";
}

export class ProviderAuth {
  readonly vault: EncryptedAuth;
  readonly ports: AgentAuthPorts;
  readonly shutdown = new AbortController();
  readonly states = new Map<string, ProviderAuthState>();
  readonly flows = new Map<string, LoginFlow>();
  readonly work = new Set<Promise<unknown>>();
  private readonly providerWork = new Map<string, Set<Promise<unknown>>>();
  agent?: AgentRuntime;
  private timer?: ReturnType<typeof setInterval>;
  private maintenancePaused = false;
  constructor(
    db: DatabaseSync,
    cipher: SecretCipher,
    readonly redactor: Redactor,
    readonly providers: ProviderStore,
    readonly options: { home: string; platform: string; appData?: string },
    readonly changed: () => void,
    readonly hooks: ProviderAuthHooks = {},
  ) {
    this.vault = new EncryptedAuth(db, cipher, redactor);
    const refused = async (): Promise<never> => {
      throw new RpcError(-32602, "subscription_unsupported");
    };
    this.ports = {
      chatgptHostId: () => chatgptHostId(this.providers.repo),
      usageLimit: (id, limited) => this.usageLimit(id, limited),
      planRequest: (route) => this.hooks.planRequest?.(route),
      mode: (id) => this.mode(id),
      has: (id) => this.has(id, this.mode(id)),
      // A closed release never decrypts or writes model OAuth ciphertext.
      read: (id) => (this.chatgptOpen(id) ? this.vault.read(id) : Promise.resolve(undefined)),
      entries: () =>
        CHATGPT_PLAN_PROVIDERS.filter((id) => this.chatgptOpen(id) && this.vault.has(id)).map(
          (providerId) => ({ providerId, type: "oauth" as const }),
        ),
      modify: (id, update, signal) =>
        this.chatgptOpen(id) ? this.vault.modify(id, update, signal) : refused(),
      remove: (id, signal) => (this.chatgptOpen(id) ? this.vault.remove(id, signal) : refused()),
      cloud: (id, signal) => this.cloud(id, signal),
      reauth: (id) => this.state(id, "reauthRequired", "auth_failed"),
      authenticated: (id) => {
        if (this.shutdown.signal.aborted || this.mode(id) !== "oauth" || this.flows.has(id)) return;
        if (this.getState(id).state !== "connected") this.state(id, "connected");
      },
    };
  }
  private chatgptOpen(id: string) {
    return isChatGPTPlanProvider(id) && chatGPTSignInAvailability().available;
  }
  isIdle() {
    return this.flows.size === 0 && this.providerWork.size === 0 && this.work.size === 0;
  }
  async pauseMaintenance() {
    this.maintenancePaused = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled([...this.providerWork.values()].flatMap((work) => [...work]));
  }
  resumeMaintenance() {
    this.maintenancePaused = false;
    this.start();
  }
  mode(id: string): ReturnType<AgentAuthPorts["mode"]> {
    // The plan provider is sign-in only, closed release or not, so nothing ever treats it as a
    // key provider (the phone's offline grants among them).
    if (isChatGPTPlanProvider(id)) return "oauth";
    const row = this.providers.repo.get(id);
    if (row?.kind === "custom") return "custom";
    return row?.config.selectedAuth === "cloud" ? "cloud" : "apiKey";
  }
  has(id: string, auth: string) {
    if (auth === "oauth") return this.chatgptOpen(id) && this.vault.has(id);
    return auth === "cloud"
      ? this.vault.secrets.has(cloudScope(id), "credential")
      : this.providers.secrets.has(`provider:${id}`, "apiKey");
  }
  config(id: string): CloudConfig | null {
    const value = this.providers.repo.get(id)?.config.cloud;
    return value ? CloudConfigSchema.parse(value) : null;
  }
  async cloud(id: string, signal: AbortSignal): Promise<CloudMaterial | undefined> {
    signal.throwIfAborted();
    if (this.mode(id) !== "cloud") return undefined;
    const text = await this.vault.secrets.get(cloudScope(id), "credential");
    signal.throwIfAborted();
    if (!text) return undefined;
    const material = materialSchema.parse(JSON.parse(text));
    if (material.providerId !== id) throw new RpcError(-32603, "invalid_cloud_credentials");
    registerSecretLeaves(material, this.redactor);
    return material;
  }
  async setCloud(input: MethodParams["providers.setCredentials"]): Promise<void> {
    const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(20_000)]);
    const { config, material } = await prepareCloud(input, this.options, signal);
    registerSecretLeaves(material, this.redactor);
    if (this.redactor.redact(JSON.stringify(config)) !== JSON.stringify(config))
      throw new RpcError(-32602, "metadata_contains_credentials");
    signal.throwIfAborted();
    await this.vault.write(cloudScope(input.providerId), "credential", material, () => {
      this.providers.repo.upsert({
        id: input.providerId,
        kind: "builtin",
        config: {
          ...this.providers.repo.get(input.providerId)?.config,
          selectedAuth: "cloud",
          cloud: config,
        },
      });
    });
    this.changed();
  }
  select(id: string, auth: "apiKey" | "oauth") {
    // No provider switches to a sign-in any more: the ChatGPT plan is a provider of its own.
    if (
      auth !== "apiKey" ||
      !this.providers.catalog.some((p) => p.id === id && p.auth === auth && p.available)
    )
      throw new RpcError(-32602, "unsupported_auth");
    this.patch(id, { selectedAuth: auth });
  }
  private patch(id: string, values: Record<string, string | boolean | null>) {
    const config = { ...this.providers.repo.get(id)?.config };
    for (const [key, value] of Object.entries(values))
      if (value === null) delete config[key];
      else config[key] = value;
    this.providers.repo.upsert({ id, kind: "builtin", config });
    this.changed();
  }
  /** A plan provider's sign-in summary; account and limit flags are plain display data. */
  chatgpt(id: string): ChatGPTSignIn {
    const access = chatGPTSignInAvailability();
    const config = this.providers.repo.get(id)?.config;
    const account = z.string().max(320).safeParse(config?.chatgptAccount);
    return {
      ...access,
      state: this.getState(id).state,
      ...(access.available && account.success ? { account: account.data } : {}),
      ...(access.available && config?.chatgptUsageLimited === true ? { usageLimited: true } : {}),
    };
  }
  private usageLimit(id: string, limited: boolean) {
    if (!this.chatgptOpen(id) || this.shutdown.signal.aborted) return;
    // Only a change is written: every plan reply reports, and most report "not limited".
    if ((this.providers.repo.get(id)?.config.chatgptUsageLimited === true) === limited) return;
    this.patch(id, { chatgptUsageLimited: limited ? true : null });
  }
  getState(id: string): ProviderAuthState {
    if (!this.chatgptOpen(id)) return { providerId: id, state: "disconnected" };
    const saved = this.providers.repo.authState(id);
    return (
      this.states.get(id) ??
      (saved.state === "connecting"
        ? { providerId: id, state: "disconnected" }
        : saved.state === "disconnected" && this.vault.has(id)
          ? { providerId: id, state: "connected" }
          : saved)
    );
  }
  state(id: string, state: ProviderAuthState["state"], error?: ProviderAuthState["error"]) {
    const previous = this.getState(id).state;
    const value = { providerId: id, state, ...(error ? { error } : {}) };
    this.providers.repo.setAuthState(value);
    this.states.set(id, value);
    this.hooks.stateChanged?.(value);
    this.changed();
    if (state === "reauthRequired" && previous !== state)
      this.hooks.audit?.(id, "oauth.reauth_required");
    return value;
  }
  assertLoginSupported(id: string) {
    if (!isChatGPTPlanProvider(id)) throw new RpcError(-32602, "subscription_unsupported");
    const access = chatGPTSignInAvailability();
    if (!access.available)
      throw new RpcError(-32602, access.unavailableReason ?? "openai_approval_required");
  }
  /**
   * A second sign-in while one is pending restarts it: the person clicked again because the first
   * browser tab is gone or never reached Pi Bot, so the old listener is cancelled and fully closed
   * (it may hold 127.0.0.1:1455) before a new one starts. Without a pending flow this stays
   * synchronous, so refusals still throw at the call.
   */
  login(id: string): ProviderAuthState | Promise<ProviderAuthState> {
    this.assertLoginSupported(id);
    return this.flows.has(id) ? this.restartLogin(id) : this.beginLogin(id);
  }
  private async restartLogin(id: string): Promise<ProviderAuthState> {
    for (let attempt = 0; this.flows.has(id); attempt++) {
      if (attempt >= 3) throw new RpcError(-32001, "login_busy");
      this.flows.get(id)?.cancel();
      await Promise.allSettled([...(this.providerWork.get(id) ?? [])]);
    }
    return this.beginLogin(id);
  }
  private beginLogin(id: string): ProviderAuthState {
    this.shutdown.signal.throwIfAborted();
    if (!this.agent?.login) throw new RpcError(-32001, "login_busy");
    const flow = new LoginFlow(
      id,
      this.shutdown.signal,
      this.redactor,
      (step) => this.hooks.stepChanged?.(step),
      async (url, signal) => {
        if (!this.hooks.openExternal) throw new RpcError(-32603, "browser_unavailable");
        await this.hooks.openExternal(url, signal);
      },
    );
    this.flows.set(id, flow);
    try {
      // The user confirmed the first-use explanation (what is sent, to whom) before this call.
      this.hooks.audit?.(id, "oauth.risk_acknowledged");
      this.state(id, "connecting");
    } catch (error) {
      flow.dispose();
      this.flows.delete(id);
      throw error;
    }
    const work = this.agent
      .login(id, flow.interaction)
      .then(
        async () => {
          const account = (await this.vault.read(id))?.account;
          this.patch(id, {
            chatgptAccount: typeof account === "string" ? account.slice(0, 320) : null,
            chatgptUsageLimited: null,
          });
          this.state(id, "connected");
          this.hooks.audit?.(id, "oauth.connected");
        },
        (error: unknown) => {
          const aborted = flow.signal.aborted;
          this.state(
            id,
            aborted ? "disconnected" : "error",
            aborted ? (flow.cancelled ? "cancelled" : "timeout") : failureState(error),
          );
          this.hooks.audit?.(id, "oauth.failed");
        },
      )
      .finally(() => {
        flow.dispose();
        this.flows.delete(id);
      })
      .catch(() => {
        /* State/audit observers may fail during shutdown; the listener is already released. */
      });
    this.track(id, work);
    return this.getState(id);
  }
  cancel(id: string) {
    this.flows.get(id)?.cancel();
  }
  async logout(id: string) {
    this.assertLoginSupported(id);
    this.cancel(id);
    await Promise.allSettled([...(this.providerWork.get(id) ?? [])]);
    await this.vault.remove(id);
    // Disconnecting forgets the registration too; the next sign-in registers Pi Bot anew.
    this.patch(id, {
      chatgptAccount: null,
      chatgptUsageLimited: null,
    });
    this.state(id, "disconnected");
    this.hooks.audit?.(id, "oauth.disconnected");
  }
  refresh() {
    if (this.maintenancePaused || this.shutdown.signal.aborted) return;
    for (const entry of this.ports.entries()) {
      if (
        this.mode(entry.providerId) !== "oauth" ||
        !this.agent?.refreshAuth ||
        this.flows.has(entry.providerId) ||
        this.providerWork.has(entry.providerId)
      )
        continue;
      // Started refreshes have their own deadline and must save rotated credentials before DB close.
      const work = this.agent
        .refreshAuth(entry.providerId, AbortSignal.timeout(15_000))
        .catch((error) => {
          if (this.shutdown.signal.aborted || this.mode(entry.providerId) !== "oauth") return;
          const code = mapAgentError(error);
          // Transient failures keep the credential for the next timer; only a definitive
          // rejection needs another interactive sign-in.
          this.hooks.refreshFailed?.(entry.providerId, code);
          if (code === "auth_failed" && this.getState(entry.providerId).state !== "reauthRequired")
            this.state(entry.providerId, "reauthRequired", "auth_failed");
        });
      this.track(entry.providerId, work);
    }
  }
  start() {
    if (this.timer || this.maintenancePaused || this.shutdown.signal.aborted) return;
    // A closed release has nothing to refresh; never start a timer that would read ciphertext.
    if (!chatGPTSignInAvailability().available) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 60_000);
    this.timer.unref();
  }
  private track(id: string, work: Promise<unknown>) {
    const pending = this.providerWork.get(id) ?? new Set<Promise<unknown>>();
    this.providerWork.set(id, pending);
    pending.add(work);
    this.work.add(work);
    const release = () => {
      pending.delete(work);
      this.work.delete(work);
      if (!pending.size) this.providerWork.delete(id);
    };
    void work.then(release, release);
  }
  async drainInteractive() {
    const ids = [...this.flows.keys()];
    const pending = ids.flatMap((id) => [...(this.providerWork.get(id) ?? [])]);
    for (const id of ids) this.flows.get(id)?.cancel();
    // Keep refresh/keyring lifetime intact for scheduled work and a later GUI sign-in.
    await Promise.allSettled(pending);
  }
  cancelAll() {
    if (this.timer) clearInterval(this.timer);
    this.shutdown.abort();
    for (const flow of this.flows.values()) flow.cancel();
  }
  async stop() {
    this.cancelAll();
    await Promise.allSettled([...this.work]);
    await this.vault.settled();
  }
}
