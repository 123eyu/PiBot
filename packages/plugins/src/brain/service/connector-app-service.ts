import { randomUUID } from "node:crypto";
import { connectorDigest } from "@pibot/brain/kit";
import type { BuiltinAppConnect } from "@pibot/plugins-contract/full";
import {
  type Connector,
  type ConnectorConnectionFactory,
  type ConnectorOAuthStorage,
  type ConnectorServer,
  RpcError,
  RpcErrorCodes,
} from "@pibot/plugins-contract/full";
import type { AuditRepo, SecretStore } from "@pibot/storage";
import type { ConnectorOperationsRepo, ConnectorsRepo, PluginsRepo } from "../../store/index.ts";
import type { PluginRegistry } from "../apps/registry.ts";
import { importSecretPrefix, USER_SECRET_SCOPE } from "./connector-import.ts";

interface AppDeps {
  registry: PluginRegistry;
  plugins: PluginsRepo;
  connectors: ConnectorsRepo;
  operations: ConnectorOperationsRepo;
  secrets: SecretStore;
  audit: AuditRepo;
  actorBotId: string;
  factory: ConnectorConnectionFactory;
  platform?: string;
  cancellationTimeoutMs?: number;
  openExternal?(url: string): Promise<void>;
  registerSecret?(value: string): void;
  beforeEnable(connector: Connector): Promise<void>;
  start(operation: ReturnType<ConnectorOperationsRepo["request"]>): Promise<void>;
  changed(connectorId: string): void;
  pluginChanged(installationId: string): void;
  needsAuth?(connectorId: string): void;
  authorizeBuiltinOAuth?(
    connectorId: string,
    expectedRevision: number,
    signal: AbortSignal,
  ): Promise<void>;
}
const unavailable = () =>
  new RpcError(RpcErrorCodes.connectorUnavailable, "Connector authorization unavailable");

/** Every `${secret:NAME}` a connection's configuration reads (headers, env, URL). */
function referencedSecretNames(server: ConnectorServer | undefined): Set<string> {
  const names = new Set(server?.auth.secretNames ?? []);
  const fields =
    server?.transport === "http" ? server.headers : server?.transport === "stdio" ? server.env : {};
  for (const value of Object.values(fields))
    for (const match of value.matchAll(/\$\{secret:([A-Z][A-Z0-9_]{0,63})\}/g))
      if (match[1]) names.add(match[1]);
  if (server?.transport === "http")
    for (const match of server.url.matchAll(/\$\{secret:([A-Z][A-Z0-9_]{0,63})\}/g))
      if (match[1]) names.add(match[1]);
  return names;
}

function importedTokenName(connector: Connector, server: ConnectorServer, name: string) {
  const referenced = referencedSecretNames(server);
  const imported = `${importSecretPrefix(connector.pluginInstallationId)}${name}`;
  if (referenced.has(imported)) return imported;
  return referenced.has(name) ? name : undefined;
}

function replacementTokenName(
  connector: Connector,
  server: ConnectorServer,
  definition: ReturnType<PluginRegistry["fromInstallation"]>,
): string | undefined {
  let name: string | undefined;
  if (server.transport === "http") {
    const headers = Object.entries(server.headers).filter(
      ([key]) => key.toLowerCase() === "authorization",
    );
    if (headers.length !== 1) return;
    name = /^Bearer \$\{secret:([A-Z][A-Z0-9_]{0,63})\}$/i.exec(headers[0]?.[1] ?? "")?.[1];
    const references = Object.values(server.headers).flatMap((value) =>
      [...value.matchAll(/\$\{secret:([A-Z][A-Z0-9_]{0,63})\}/g)].map((match) => match[1]),
    );
    if (new Set(references).size !== 1) return;
  } else if (definition?.mcp && server.auth.kind === "bearer") {
    if (server.transport === "builtin") name = server.auth.secretNames[0];
    else if (server.transport === "stdio") {
      const references = Object.values(server.env).flatMap((value) =>
        [...value.matchAll(/\$\{secret:([A-Z][A-Z0-9_]{0,63})\}/g)].map((match) => match[1]),
      );
      if (new Set(references).size !== 1) return;
      name = references[0];
    }
  }
  if (
    !name?.startsWith(`IMPORT_${connector.pluginInstallationId.replaceAll("-", "").toUpperCase()}_`)
  )
    return;
  if (
    server.auth.secretNames.length &&
    (server.auth.secretNames.length !== 1 || server.auth.secretNames[0] !== name)
  )
    return;
  return name;
}

/** User-facing setup only; model calls never enter this service's authorization methods. */
export class ConnectorAppService {
  private readonly authorizations = new Map<
    string,
    { connectorId: string; controller: AbortController; promise: Promise<void> }
  >();
  private readonly connecting = new Set<string>();
  constructor(private readonly deps: AppDeps) {}

  list() {
    return {
      items: this.deps.registry.list((this.deps.platform ?? process.platform) as NodeJS.Platform),
    };
  }

  async connect(input: BuiltinAppConnect) {
    const definition = this.deps.registry.get(input.appId);
    const mcp = definition?.mcp;
    const card = this.list().items.find((entry) => entry.id === input.appId);
    if (
      !definition ||
      !mcp ||
      !card?.supported ||
      !card.modes.some((entry) => entry.id === input.mode)
    )
      throw unavailable();
    if (this.connecting.has(input.appId))
      throw new RpcError(RpcErrorCodes.busy, "Application setup in progress");
    this.connecting.add(input.appId);
    try {
      // Builtin account connections are singletons. Imported MCP installations remain independent.
      for (let cursor: string | undefined; ; ) {
        const page = this.deps.plugins.list({ cursor, limit: 100 });
        for (const item of page.items) {
          if (
            item.sourceKind !== "builtin" ||
            item.pluginId !== `pibot.${input.appId}` ||
            item.status === "removed"
          )
            continue;
          const connectors = this.deps.plugins.connections(item.id);
          if (!connectors.length) continue;
          // A declined native prompt leaves the installation intact. Retry only the same
          // credential-free configuration, never replace an account or enable an edited server.
          const needsBuiltinOAuth = input.mode === "oauth" && mcp.oauthStartTool !== undefined;
          if (
            !input.enable ||
            input.token ||
            mcp.authorizeOnEnable ||
            mcp.requiresToken?.(input.mode)
          )
            throw new RpcError(RpcErrorCodes.busy, "Application already connected");
          const expected = this.deps.registry.manifest(input);
          const presets = new Map(expected.servers.map((server) => [server.id, server]));
          if (
            connectors.length !== expected.servers.length ||
            connectors.some((connector) => {
              const server = this.deps.connectors.configuration(connector.id);
              const preset = presets.get(connector.serverId);
              return (
                connector.enabled ||
                connector.status !== "disabled" ||
                !server ||
                !preset ||
                connectorDigest(server) !== connectorDigest(preset)
              );
            })
          )
            throw new RpcError(RpcErrorCodes.busy, "Application already connected");
          await this.enable(connectors, needsBuiltinOAuth || Boolean(mcp.authorizeOnEnable));
          return {
            installation: this.deps.plugins.get(item.id) ?? item,
            connectors: connectors.map((row) => this.deps.connectors.get(row.id) ?? row),
          };
        }
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      const installationId = randomUUID();
      const requiresToken = mcp.requiresToken?.(input.mode) === true;
      const gmailPassword = input.appId === "gmail" && input.mode === "app-password";
      if (input.email && !gmailPassword)
        throw new RpcError(RpcErrorCodes.invalidParams, "Unexpected account address");
      if (
        gmailPassword &&
        (!input.email || !/^[A-Za-z0-9]{16}$/.test((input.token ?? "").replace(/ /g, "")))
      )
        throw new RpcError(RpcErrorCodes.invalidParams, "Gmail address and app password required");
      if (requiresToken && !input.token)
        throw new RpcError(RpcErrorCodes.invalidParams, "Access token required");
      if (!requiresToken && input.token)
        throw new RpcError(
          RpcErrorCodes.invalidParams,
          "This connection does not use an access token",
        );
      const credentialName = requiresToken
        ? `IMPORT_${installationId.replaceAll("-", "").toUpperCase()}_TOKEN`
        : undefined;
      const commit =
        credentialName && input.token
          ? await this.deps.secrets.prepareSet(
              USER_SECRET_SCOPE,
              credentialName,
              gmailPassword
                ? JSON.stringify({ email: input.email, appPassword: input.token.replace(/ /g, "") })
                : input.token,
            )
          : undefined;
      const manifest = this.deps.registry.manifest(input, credentialName);
      const receipt = this.deps.plugins.install({
        id: installationId,
        manifest,
        digest: connectorDigest(manifest),
        sourceKind: "builtin",
        actorBotId: this.deps.actorBotId,
        commitSecrets: commit,
      });
      this.deps.pluginChanged(installationId);
      if (input.enable)
        await this.enable(
          receipt.connectors,
          (input.mode === "oauth" && mcp.oauthStartTool !== undefined) ||
            Boolean(mcp.authorizeOnEnable),
        );
      return {
        installation: this.deps.plugins.get(installationId) ?? receipt.installation,
        connectors: receipt.connectors.map((item) => this.deps.connectors.get(item.id) ?? item),
      };
    } finally {
      this.connecting.delete(input.appId);
    }
  }

  private async enable(connectors: Connector[], authorize: boolean) {
    for (const connector of connectors) {
      if (authorize) {
        await this.authorize({ id: connector.id, expectedRevision: connector.revision });
      } else {
        await this.deps.beforeEnable(connector);
        const operation = this.deps.operations.request(
          { id: connector.id, expectedRevision: connector.revision, kind: "enable" },
          this.deps.actorBotId,
        );
        void this.deps.start(operation);
      }
    }
  }

  oauthStorage(connectorId: string, verify: () => void = () => undefined): ConnectorOAuthStorage {
    const register = (value: string) => {
      const state = JSON.parse(value) as {
        tokens?: { access_token?: string; refresh_token?: string };
        client?: { client_secret?: string };
      };
      for (const secret of [
        state.tokens?.access_token,
        state.tokens?.refresh_token,
        state.client?.client_secret,
      ])
        if (secret) this.deps.registerSecret?.(secret);
    };
    return {
      load: async () => {
        verify();
        const value = await this.deps.secrets.get(`connector:${connectorId}`, "oauth");
        verify();
        if (value) register(value);
        return value;
      },
      save: async (value) => {
        verify();
        // Register individual credentials as well as the encrypted blob before any SDK diagnostics.
        register(value);
        const commit = await this.deps.secrets.prepareSet(
          `connector:${connectorId}`,
          "oauth",
          value,
        );
        verify();
        commit();
      },
    };
  }

  async authorize(input: {
    id: string;
    expectedRevision: number;
    token?: string;
    tokenName?: string;
  }) {
    const connector = this.deps.connectors.get(input.id);
    const server = connector && this.deps.connectors.configuration(connector.id);
    if (!connector || !server || connector.revision !== input.expectedRevision) throw unavailable();
    if ([...this.authorizations.values()].some((item) => item.connectorId === input.id))
      throw new RpcError(RpcErrorCodes.busy, "Authorization in progress");
    const authorizationId = randomUUID();
    const controller = new AbortController();
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const installation = this.deps.plugins.get(connector.pluginInstallationId);
    // 访问令牌: a brought-over connection can read several imported tokens (e.g. through
    // its environment); the dialog names the one to replace, and only a name the
    // configuration actually reads is accepted.
    const tokenName = input.tokenName
      ? importedTokenName(connector, server, input.tokenName)
      : replacementTokenName(connector, server, this.deps.registry.fromInstallation(installation));
    if (server.auth.kind !== "oauth" && (!input.token || !tokenName))
      throw new RpcError(
        RpcErrorCodes.connectorUnavailable,
        "connector_credential_requires_secret_settings",
      );
    const builtinOauth =
      server.auth.kind === "oauth" &&
      server.transport === "stdio" &&
      !!installation &&
      !!this.deps.registry.fromInstallation(installation)?.mcp?.oauthStartTool;
    if (
      server.auth.kind === "oauth" &&
      (input.token ||
        (!builtinOauth &&
          (server.transport !== "http" ||
            !this.deps.factory.authorizeOAuth ||
            !this.deps.openExternal)))
    )
      throw unavailable();
    if (builtinOauth && !this.deps.authorizeBuiltinOAuth) throw unavailable();
    const job = Promise.resolve()
      .then(async () => {
        let operation: ReturnType<ConnectorOperationsRepo["request"]> | undefined;
        try {
          if (input.token && tokenName) {
            // Encrypt first; both lifecycle CAS and credential write then happen without an await.
            const commit = await this.deps.secrets.prepareSet(
              USER_SECRET_SCOPE,
              tokenName,
              input.token,
            );
            controller.signal.throwIfAborted();
            operation = this.deps.operations.request(
              {
                id: input.id,
                expectedRevision: input.expectedRevision,
                kind: connector.enabled ? "restart" : "enable",
              },
              this.deps.actorBotId,
            );
            commit();
          } else
            operation = this.deps.operations.request(
              {
                id: input.id,
                expectedRevision: input.expectedRevision,
                kind: connector.enabled ? "restart" : "enable",
              },
              this.deps.actorBotId,
            );
          this.deps.changed(input.id);
          const activeOperation = operation;
          const verify = () => {
            controller.signal.throwIfAborted();
            this.deps.operations.current(activeOperation.id, activeOperation.revision);
          };
          if (builtinOauth) {
            await this.deps.start(operation);
            controller.signal.throwIfAborted();
            const completed = this.deps.operations.get(operation.id);
            const ready = this.deps.connectors.get(connector.id);
            if (completed?.state !== "done" || !ready?.enabled || ready.status !== "ready")
              throw unavailable();
            // Catalog publishing and built-in defaults can advance the connector revision.
            // Pin the live receipt after startup, not an assumed +1.
            await this.deps.authorizeBuiltinOAuth?.(
              connector.id,
              ready.revision,
              controller.signal,
            );
          } else if (server.auth.kind === "oauth" && server.transport === "http") {
            await this.deps.factory.authorizeOAuth?.({
              url: server.url,
              storage: this.oauthStorage(input.id, verify),
              signal: controller.signal,
              openExternal: (url) => this.deps.openExternal?.(url) ?? Promise.reject(unavailable()),
            });
            verify();
          }
          if (!builtinOauth) await this.deps.start(operation);
        } catch {
          if (operation) {
            try {
              const current = this.deps.operations.get(operation.id);
              this.deps.operations.fail(
                operation.id,
                current?.revision ?? operation.revision,
                controller.signal.aborted ? "cancelled" : "auth_required",
                this.deps.actorBotId,
              );
            } catch {
              /* A newer stop/uninstall owns the row and must not be overwritten. */
            }
          }
          this.deps.changed(input.id);
          if (!controller.signal.aborted) this.deps.needsAuth?.(input.id);
        }
      })
      .finally(() => this.authorizations.delete(authorizationId));
    this.authorizations.set(authorizationId, { connectorId: input.id, controller, promise: job });
    return { authorizationId, expiresAt };
  }

  /** 访问令牌: connections whose single token Pi Bot stores; bounded to the first 200. */
  tokens() {
    const items: {
      connectorId: string;
      connectorName: string;
      connectorRevision: number;
      installationId: string;
      name: string;
      hasValue: boolean;
    }[] = [];
    let cursor: string | undefined;
    do {
      const page = this.deps.connectors.list({ cursor, limit: 100 });
      for (const connector of page.items) {
        const server = this.deps.connectors.configuration(connector.id);
        const installation = this.deps.plugins.get(connector.pluginInstallationId);
        if (!server || installation?.status !== "installed") continue;
        const primary = replacementTokenName(
          connector,
          server,
          this.deps.registry.fromInstallation(installation),
        );
        // Stored names carry the installation prefix; the rest is the name the other tool used.
        const prefix = importSecretPrefix(installation.id);
        // Second-Mac test: a brought-over stdio server reads its key through env with no bearer
        // auth, so the single-token rule found nothing and the token was invisible.
        const names = primary
          ? [primary]
          : [...referencedSecretNames(server)].filter((name) => name.startsWith(prefix));
        for (const name of names)
          items.push({
            connectorId: connector.id,
            connectorName: connector.name,
            connectorRevision: connector.revision,
            installationId: installation.id,
            name:
              name.startsWith(prefix) && name.length > prefix.length
                ? name.slice(prefix.length)
                : name,
            hasValue: this.deps.secrets.has(USER_SECRET_SCOPE, name),
          });
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor && items.length < 200);
    return items.slice(0, 200);
  }

  canReplaceCredential(connectorId: string): boolean {
    const connector = this.deps.connectors.get(connectorId);
    if (!connector) return false;
    const installation = this.deps.plugins.get(connector.pluginInstallationId);
    return (
      replacementTokenName(
        connector,
        this.deps.connectors.configuration(connectorId),
        this.deps.registry.fromInstallation(installation),
      ) !== undefined
    );
  }

  cancel(authorizationId: string) {
    this.authorizations.get(authorizationId)?.controller.abort();
    return { ok: true as const };
  }
  cancelConnector(connectorId: string) {
    for (const item of this.authorizations.values())
      if (item.connectorId === connectorId) item.controller.abort();
  }
  async cancelAndDrain(connectorId: string): Promise<void> {
    this.cancelConnector(connectorId);
    const pending = [...this.authorizations.values()]
      .filter((item) => item.connectorId === connectorId)
      .map((item) => item.promise);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(pending),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new RpcError(RpcErrorCodes.connectorUnavailable, "Authorization cleanup timed out"),
              ),
            this.deps.cancellationTimeoutMs ?? 10_000,
          );
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async dispose() {
    for (const item of this.authorizations.values()) item.controller.abort();
    await Promise.all([...this.authorizations.values()].map((item) => item.promise));
  }

  removeCredentials(connector: Connector) {
    const server = this.deps.connectors.configurationForCleanup(
      connector.id,
      connector.pluginInstallationId,
    );
    this.deps.secrets.remove(`connector:${connector.id}`, "oauth");
    this.deps.secrets.remove(`connector:${connector.id}`, "windows-ack");
    const prefix = `IMPORT_${connector.pluginInstallationId.replaceAll("-", "").toUpperCase()}_`;
    for (const name of referencedSecretNames(server ?? undefined))
      if (name.startsWith(prefix)) this.deps.secrets.remove(USER_SECRET_SCOPE, name);
  }
}
