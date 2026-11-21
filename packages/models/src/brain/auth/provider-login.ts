import { randomUUID } from "node:crypto";
import type { LoginInteraction } from "@pibot/agent";
import { registerSecretText } from "@pibot/brain/kit";
import {
  CHATGPT_CODEX_PROVIDER,
  type LoginStep,
  LoginStepSchema,
  RpcError,
} from "@pibot/models-contract/full";
import type { Redactor } from "@pibot/secrets";

const CALLBACK_PATH = "/auth/callback";
/** pi's legacy Codex login: the Codex CLI's public client id and its fixed loopback redirect. */
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_REDIRECT = "http://localhost:1455/auth/callback";

/**
 * One interactive Sign in with ChatGPT attempt. The brain-side checks are independent of the
 * agent's: only OpenAI's authorize endpoint is opened, only a 127.0.0.1 loopback callback with
 * this attempt's state is accepted, and the registration request names Pi Bot.
 */
export class LoginFlow {
  readonly controller = new AbortController();
  readonly signal: AbortSignal;
  readonly interaction: LoginInteraction;
  cancelled = false;
  step: LoginStep | null = null;
  private state?: string;
  private callbackOrigin?: string;
  private claimed = false;
  private pending?: { resolve(value: string): void; reject(error: unknown): void; cleanup(): void };
  constructor(
    readonly id: string,
    parent: AbortSignal,
    readonly redactor: Redactor,
    readonly emit: (step: LoginStep) => void,
    readonly open: (url: string, signal: AbortSignal) => Promise<void>,
  ) {
    this.signal = AbortSignal.any([parent, this.controller.signal, AbortSignal.timeout(300_000)]);
    this.interaction = {
      signal: this.signal,
      prompt: (input) => this.prompt(input),
      notify: (event) => this.notify(event),
    };
  }
  private publish(step: Omit<LoginStep, "providerId" | "promptId">) {
    this.step = LoginStepSchema.parse({ providerId: this.id, promptId: randomUUID(), ...step });
    this.emit(this.step);
  }
  private async prompt(input: Parameters<LoginInteraction["prompt"]>[0]): Promise<string> {
    this.signal.throwIfAborted();
    if (this.pending || input.type !== "manual_code") throw new RpcError(-32001, "login_busy");
    return new Promise((resolve, reject) => {
      const signal = AbortSignal.any([this.signal, input.signal ?? this.signal]);
      const abort = () => {
        this.pending?.cleanup();
        this.pending = undefined;
        reject(new RpcError(-32001, "login_cancelled"));
      };
      const cleanup = () => signal.removeEventListener("abort", abort);
      this.pending = { resolve, reject, cleanup };
      signal.addEventListener("abort", abort, { once: true });
      try {
        // The browser stays open; this step adds the paste-the-callback fallback under it.
        this.publish({ kind: "manual_code" });
      } catch (error) {
        cleanup();
        this.pending = undefined;
        reject(error);
      }
      if (signal.aborted) abort();
    });
  }
  input(promptId: string, value: string) {
    this.signal.throwIfAborted();
    if (!this.pending || this.step?.promptId !== promptId)
      throw new RpcError(-32602, "stale_login_prompt");
    registerSecretText(value, this.redactor);
    let url: URL;
    try {
      url = new URL(value.trim());
    } catch {
      throw new RpcError(-32602, "invalid_oauth_state");
    }
    if (
      !this.callbackOrigin ||
      url.origin !== this.callbackOrigin ||
      url.pathname !== CALLBACK_PATH ||
      url.username ||
      url.password ||
      url.hash ||
      !url.searchParams.get("code") ||
      !url.searchParams.get("client_id") ||
      url.searchParams.has("error") ||
      url.searchParams.get("state") !== this.state ||
      this.claimed
    )
      throw new RpcError(-32602, "invalid_oauth_state");
    this.claimed = true;
    const pending = this.pending;
    pending.cleanup();
    this.pending = undefined;
    this.step = null;
    pending.resolve(value);
  }
  private notify(event: Parameters<LoginInteraction["notify"]>[0]) {
    // SDK notify is synchronous. Abort instead of throwing, so the callback listener reaches finally.
    try {
      if (event.type !== "auth_url" || !event.url) return;
      this.redactor.add(event.url);
      const url = this.external(event.url);
      const state = url.searchParams.get("state");
      if (!state) throw new Error("Unexpected authorization request");
      const clientId = url.searchParams.get("client_id");
      const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
      const firstRegistration = clientId === "dynamic_agent_client";
      // The legacy Codex sign-in (maintainers 2026-11-15) has its own fixed shape; it is accepted only
      // for its own provider, so the official sign-in can never be steered to it or back.
      const codex = this.id === CHATGPT_CODEX_PROVIDER;
      if (
        codex &&
        (url.pathname !== "/oauth/authorize" ||
          !state ||
          clientId !== CODEX_CLIENT_ID ||
          url.searchParams.get("redirect_uri") !== CODEX_REDIRECT)
      )
        throw new Error("Unexpected authorization request");
      if (
        !codex &&
        (url.pathname !== "/api/accounts/authorize" ||
          !state ||
          !clientId ||
          // A first registration introduces Pi Bot; a re-sign-in uses the issued ID without a hint.
          (firstRegistration
            ? url.searchParams.get("agent_name_hint") !== "Pi Bot"
            : url.searchParams.has("agent_name_hint")) ||
          callback.protocol !== "http:" ||
          callback.hostname !== "127.0.0.1" ||
          !callback.port ||
          callback.username ||
          callback.password ||
          callback.pathname !== CALLBACK_PATH ||
          callback.search ||
          callback.hash)
      )
        throw new Error("Unexpected authorization request");
      this.state = state;
      this.callbackOrigin = callback.origin;
      this.publish({ kind: "browser" });
      void this.open(url.href, this.signal).catch(() => this.cancel());
    } catch {
      this.cancel();
    }
  }
  private external(raw: string): URL {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "auth.openai.com" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash
    )
      throw new Error("Invalid authorization endpoint");
    return url;
  }
  cancel() {
    this.cancelled = true;
    this.controller.abort();
  }
  dispose() {
    this.controller.abort();
    this.pending?.cleanup();
    this.pending = undefined;
    this.step = null;
  }
}
