// Import normalization: the JSON source is untrusted; schema validation, secret
// migration and the digest all happen here before anything is persisted. The
// plaintext secrets collected during normalization exist only in memory until
// plugins.import commits them into the SecretStore.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  hardenPluginConfigField,
  hasPluginCommandSubstitution,
  looksLikeCredential,
  looksLikeCredentialName,
  looksLikeCredentialValue,
  unsupportedClaudePluginComponents,
} from "@pibot/plugins-contract";
import {
  type ClaudePluginBundle,
  ClaudePluginBundleSchema,
  type ConnectorManifest,
  ConnectorManifestSchema,
  type ConnectorServer,
  IdSchema,
  RpcError,
  RpcErrorCodes,
} from "@pibot/plugins-contract/full";

export const USER_SECRET_SCOPE = "user-secret";
const PREVIEW_TTL_MS = 5 * 60_000;
const MAX_IMPORT_SECRET_NAMES = 64;
const SECRET_REF_GLOBAL = /\$\{secret:([A-Z][A-Z0-9_]{0,63})\}/g;
const SECRET_MARKER = "${secret:";
const PACKAGE_MANAGER_DOMAINS = {
  npx: ["registry.npmjs.org"],
  uvx: ["pypi.org", "files.pythonhosted.org"],
} as const;

/** Generated references belong to one installation, never to a global header name. */
class ImportSecretRegistry {
  private readonly byName = new Map<string, string>();

  constructor(
    private readonly reserved: Set<string>,
    private readonly prefix: string,
  ) {}

  register(base: string, value: string): string {
    const name = `${this.prefix}${base}`.slice(0, 64);
    for (let n = 1; n <= 99; n += 1) {
      const suffix = n === 1 ? "" : `_${n}`;
      const candidate = `${name.slice(0, 64 - suffix.length)}${suffix}`;
      if (this.reserved.has(candidate)) continue;
      const existing = this.byName.get(candidate);
      if (existing === value) return candidate;
      if (existing !== undefined) continue;
      this.byName.set(candidate, value);
      return candidate;
    }
    throw invalid("Too many credential name collisions in one import");
  }

  entries(): ImportedSecret[] {
    return [...this.byName].map(([name, value]) => ({ name, value }));
  }
}

export interface ImportedSecret {
  name: string;
  value: string;
}

export interface ConnectorPreview {
  previewId: string;
  /** The installation id the preview commits to; retries return the same receipt. */
  installationId: string;
  digest: string;
  expiresAt: string;
  /** Sanitized manifest: plaintext secrets replaced by ${secret:NAME} refs. */
  manifest: ConnectorManifest;
  declaredVersion?: string;
  /** Plaintext values backing the references; never serialized to the renderer. */
  secrets: ImportedSecret[];
  plugin?: ClaudePluginBundle;
  /** Brain-derived destination; never accepted from an imported manifest. */
  installationRoot?: string;
}

export interface ConnectorImportReceipt {
  previewId: string;
  installationId: string;
  digest: string;
  /** Process-keyed request binding; contains no configuration value or enable flag. */
  intentDigest: string;
  expiresAt: string;
}

export interface ConnectorImportIntent {
  skillTargets?: { bots: string[]; groups: string[] };
  enable: boolean;
  config: Readonly<Record<string, string | number | boolean>>;
}

const invalid = (reason: string) => new RpcError(RpcErrorCodes.pluginImportInvalid, reason);
const rejectUrlCredential = (): never => {
  throw invalid("connector_url_credential_unsupported");
};
const rejectCommandSubstitution = (): never => {
  throw invalid("connector_command_substitution_unsupported");
};
const rejectPluginSecretReference = (): never => {
  throw invalid("connector_plugin_secret_reference_unsupported");
};
const rejectCredentialMetadata = (values: readonly string[]) => {
  if (values.some(looksLikeCredentialValue))
    throw invalid("Plugin metadata cannot contain credentials");
};
const unsupportedImportPaths = new Set(
  unsupportedClaudePluginComponents.map((item) => item.path.toLowerCase()),
);
const hasSecretPlaceholder = (value: string) => /\$\{\s*secret/i.test(value);

interface FinalImportValidation {
  installationRoot?: string;
  substitutedStrings?: ReadonlySet<string>;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function decodeUrlComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw invalid("HTTP server URL contains invalid encoding");
  }
}

function validateRejectedUrlSegments(segments: readonly string[]) {
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index] ?? "";
    if (
      hasSecretPlaceholder(segment) ||
      looksLikeCredentialValue(segment) ||
      (index > 0 && looksLikeCredentialName(segments[index - 1] ?? ""))
    )
      rejectUrlCredential();
  }
}

function validateFinalHttpUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid("HTTP server URL is invalid");
  }
  if (url.username || url.password) rejectUrlCredential();
  validateRejectedUrlSegments(decodeUrlComponent(url.pathname).split("/"));
  if (!url.hash) return;
  const fragment = decodeUrlComponent(url.hash.slice(1));
  if (!fragment.includes("=")) validateRejectedUrlSegments(fragment.split("/"));
}

function pathCandidate(value: string): string {
  const equals = value.indexOf("=");
  return equals >= 0 ? value.slice(equals + 1) : value;
}

function validateFinalPluginPath(value: string, options: FinalImportValidation) {
  const candidate = pathCandidate(value);
  if (
    !candidate ||
    (!isAbsolute(candidate) && !candidate.startsWith(".") && !/[\\/]/.test(candidate))
  )
    return;
  const root = options.installationRoot;
  if (!root) {
    if (options.substitutedStrings?.has(value))
      throw invalid("Plugin command path requires an installation root");
    return;
  }
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  const inRoot = inside(root, absolute);
  const inPluginsDirectory = inside(dirname(root), absolute);
  if (
    (!isAbsolute(candidate) && !inRoot) ||
    (inPluginsDirectory && !inRoot) ||
    (options.substitutedStrings?.has(value) && !inRoot)
  )
    throw invalid("Plugin command path must stay inside its installation root");
  if (
    inRoot &&
    relative(root, absolute)
      .split(/[\\/]/)
      .some((segment) => unsupportedImportPaths.has(segment.toLowerCase()))
  )
    throw invalid("Plugin command path references an unsupported component");
}

function finalManifestStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(finalManifestStrings);
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([key, item]) => [key, ...finalManifestStrings(item)]);
  return [];
}

function serverSecretReferences(server: ConnectorManifest["servers"][number]): string[] {
  const names = new Set<string>();
  const values =
    server.transport === "stdio"
      ? Object.values(server.env)
      : server.transport === "http"
        ? [...Object.values(server.headers), server.url]
        : [];
  for (const value of values)
    for (const match of value.matchAll(SECRET_REF_GLOBAL)) if (match[1]) names.add(match[1]);
  return [...names].sort();
}

function recordFinalSecretReferences(manifest: ConnectorManifest): ConnectorManifest {
  return ConnectorManifestSchema.parse({
    ...manifest,
    servers: manifest.servers.map((server) => {
      const secretNames = serverSecretReferences(server);
      if (secretNames.length > MAX_IMPORT_SECRET_NAMES)
        throw invalid("connector_import_secret_limit");
      return { ...server, auth: { ...server.auth, secretNames } };
    }),
  });
}

function validateImportSecretLimit(
  manifest: ConnectorManifest,
  secrets: readonly ImportedSecret[],
  additionalNames: ReadonlySet<string> = new Set(),
) {
  const names = new Set(additionalNames);
  for (const server of manifest.servers)
    for (const name of server.auth.secretNames) names.add(name);
  for (const secret of secrets) names.add(secret.name);
  if (names.size > MAX_IMPORT_SECRET_NAMES) throw invalid("connector_import_secret_limit");
}

function validatePluginSecretNamespace(manifest: ConnectorManifest, installationId: string) {
  const prefix = importSecretPrefix(installationId);
  for (const server of manifest.servers)
    if (server.auth.secretNames.some((name) => !name.startsWith(prefix)))
      rejectPluginSecretReference();
}

/**
 * The sole post-substitution safety gate. Every import path reaches this after
 * schema normalization and secret migration, immediately before persistence.
 */
function validateFinalImportManifest(
  manifest: ConnectorManifest,
  options: FinalImportValidation = {},
): void {
  for (const server of manifest.servers) {
    if (server.transport === "http") validateFinalHttpUrl(server.url);
    if (server.transport !== "stdio") continue;
    if (hasPluginCommandSubstitution(server.command)) rejectCommandSubstitution();
    if (hasSecretPlaceholder(server.command))
      throw invalid("Command cannot carry credentials; use env secret references");
    validateFinalPluginPath(server.command, options);
    for (const arg of server.args) {
      const optionName = /^--?([^=]+)/.exec(arg)?.[1];
      if (hasSecretPlaceholder(arg) || (optionName && looksLikeCredentialName(optionName)))
        throw invalid("Command arguments cannot carry credentials; use env secret references");
      validateFinalPluginPath(arg, options);
    }
  }
  if (finalManifestStrings(manifest).some(looksLikeCredentialValue))
    throw invalid("Final connector manifest cannot contain plaintext credentials");
}

/** A header name cannot always become a secret name; derive and verify. */
function secretNameFromHeader(header: string): string | undefined {
  const derived = header
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]/g, "_")
    .replace(/^_+/, "")
    .replace(/_+$/, "")
    .slice(0, 64);
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(derived) ? derived : undefined;
}

/**
 * A sensitive header whose name cannot become a legal secret name still must
 * never reach the manifest as plaintext; a digest-derived name is stable
 * across re-imports, so receipts stay idempotent.
 */
function fallbackSecretName(header: string): string {
  return `SECRET_${createHash("sha256").update(header).digest("hex").slice(0, 8).toUpperCase()}`;
}

const encodedSecretRef = /(?:%24|\$)%7Bsecret(?::|%3A)([A-Z][A-Z0-9_]{0,63})%7D/gi;
const restoreSecretRefs = (value: string) =>
  value.replace(encodedSecretRef, (_match, name: string) => `\${secret:${name}}`);

function sanitizeUrlValue(
  name: string,
  value: string,
  fallback: string,
  registry: ImportSecretRegistry,
): string {
  if (!value || hasSafeReferences(name, value, false)) return value;
  if (!looksLikeCredential(name, value)) return value;
  const derived = secretNameFromHeader(name) ?? fallback;
  return `\${secret:${registry.register(derived, value)}}`;
}

function sanitizeHttpUrl(value: string, registry: ImportSecretRegistry): string {
  const url = new URL(value);
  if (url.username || url.password) rejectUrlCredential();
  if (looksLikeCredentialValue(url.hostname))
    throw invalid("HTTP server host cannot contain credentials");

  validateRejectedUrlSegments(decodeUrlComponent(url.pathname).split("/"));

  const query = [...url.searchParams.entries()];
  url.search = "";
  for (let index = 0; index < query.length; index++) {
    const [rawName, rawValue] = query[index] as [string, string];
    const name = sanitizeUrlValue("", rawName, `URL_QUERY_NAME_${index}`, registry);
    const item = sanitizeUrlValue(rawName, rawValue, `URL_QUERY_${index}`, registry);
    url.searchParams.append(name, item);
  }

  if (url.hash) {
    const fragment = decodeUrlComponent(url.hash.slice(1));
    if (fragment.includes("=")) {
      const items = [...new URLSearchParams(fragment).entries()];
      const sanitized = new URLSearchParams();
      for (let index = 0; index < items.length; index++) {
        const [rawName, rawValue] = items[index] as [string, string];
        const name = sanitizeUrlValue("", rawName, `URL_FRAGMENT_NAME_${index}`, registry);
        const item = sanitizeUrlValue(rawName, rawValue, `URL_FRAGMENT_${index}`, registry);
        sanitized.append(name, item);
      }
      url.hash = sanitized.toString();
    } else {
      validateRejectedUrlSegments(fragment.split("/"));
    }
  }
  // URL setters encode placeholders. The persisted format keeps explicit references so every
  // credential dependency is discoverable without decoding arbitrary URL text.
  return restoreSecretRefs(url.toString());
}

/** References protect only their own contents, not adjacent literal credentials. */
function hasSafeReferences(name: string, value: string, header: boolean): boolean {
  if (!value.includes(SECRET_MARKER)) return false;
  const remainder = value.replaceAll(SECRET_REF_GLOBAL, "");
  if (remainder.includes(SECRET_MARKER))
    throw invalid("Secret references must use a complete named placeholder");
  const sensitive = looksLikeCredentialName(name) || /^(?:Bearer|Basic)\s/i.test(value);
  // Keep fixed auth schemes, but reject ambiguous sensitive templates instead
  // of silently returning the literal password beside a legitimate reference.
  if (
    looksLikeCredentialValue(remainder) ||
    (sensitive &&
      !(header ? /^(?:(?:Bearer|Basic|Token|ApiKey)\s+)?\s*$/i : /^\s*$/).test(remainder))
  )
    throw invalid("Literal credentials beside references must use separate secret references");
  return true;
}

function sanitizeServer(
  server: ConnectorManifest["servers"][number],
  registry: ImportSecretRegistry,
): ConnectorManifest["servers"][number] {
  if (server.transport === "stdio") {
    if (
      server.cwd &&
      (hasPluginCommandSubstitution(server.cwd) ||
        server.cwd.includes("${") ||
        looksLikeCredentialValue(server.cwd))
    )
      throw invalid("Working directory cannot contain substitutions or credentials");
    if (hasPluginCommandSubstitution(server.command)) rejectCommandSubstitution();
    if (looksLikeCredentialValue(server.command) || server.command.includes(SECRET_MARKER))
      throw invalid("Command cannot carry credentials; use env secret references");
    for (const arg of server.args) {
      const optionName = /^--?([^=]+)/.exec(arg)?.[1];
      if (
        looksLikeCredentialValue(arg) ||
        (optionName !== undefined && looksLikeCredentialName(optionName)) ||
        arg.includes(SECRET_MARKER)
      )
        throw invalid("Command arguments cannot carry credentials; use env secret references");
    }
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(server.env)) {
      if (
        hasSafeReferences(name, value, false) ||
        (!looksLikeCredentialName(name) && !looksLikeCredentialValue(value))
      ) {
        env[name] = value;
        continue;
      }
      env[name] = `\${secret:${registry.register(name, value)}}`;
    }
    return { ...server, env };
  }
  if (server.transport !== "http") return server;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(server.headers)) {
    if (looksLikeCredentialValue(name))
      throw invalid("HTTP header names cannot contain credentials");
    if (hasSafeReferences(name, value, true)) {
      headers[name] = value;
      continue;
    }
    const bearer = /^(Bearer|Basic) (\S+)$/i.exec(value);
    const candidate = bearer?.[2] ?? value;
    if (!looksLikeCredentialName(name) && !bearer && !looksLikeCredentialValue(candidate)) {
      headers[name] = value;
      continue;
    }
    const derived = secretNameFromHeader(name) ?? fallbackSecretName(name);
    // The token is migrated, the literal scheme stays in the manifest.
    const secretName = registry.register(derived, candidate);
    headers[name] = bearer ? `${bearer[1]} \${secret:${secretName}}` : `\${secret:${secretName}}`;
  }
  return { ...server, url: sanitizeHttpUrl(server.url, registry), headers };
}

function compatibleSource(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  if (source.schemaVersion !== undefined) return source;
  const servers =
    source.mcpServers && typeof source.mcpServers === "object" && !Array.isArray(source.mcpServers)
      ? Object.entries(source.mcpServers as Record<string, unknown>)
      : source.command || source.url
        ? [["custom", source] as const]
        : undefined;
  if (!servers?.length || servers.length > 100)
    throw invalid("Expected a manifest, mcpServers map or a single MCP server");
  const used = new Set<string>();
  const normalized = servers.map(([name, raw], index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid("Invalid MCP server");
    const entry = raw as Record<string, unknown>;
    const allowed = new Set([
      "type",
      "transport",
      "command",
      "args",
      "env",
      "url",
      "headers",
      "networkDomains",
      "auth",
      "sseFallback",
      "cwd",
      "startup_timeout_sec",
      "startupTimeoutSec",
    ]);
    for (const field of Object.keys(entry))
      if (!allowed.has(field)) throw invalid(`Unsupported MCP field: ${field}`);
    let id = name
      .toLowerCase()
      .replaceAll(/[^a-z0-9.-]/g, "-")
      .slice(0, 56);
    if (!/^[a-z]/.test(id)) id = `server-${index}-${id}`.slice(0, 64);
    if (used.has(id)) throw invalid("MCP server names collide after normalization");
    used.add(id);
    const headers =
      entry.headers && typeof entry.headers === "object"
        ? (entry.headers as Record<string, unknown>)
        : {};
    const bearer = Object.entries(headers).some(
      ([header, value]) =>
        header.toLowerCase() === "authorization" &&
        typeof value === "string" &&
        /^Bearer /i.test(value),
    );
    const transport = entry.url ? "http" : "stdio";
    const declared = entry.type ?? entry.transport;
    if (
      declared &&
      ![
        transport,
        transport === "http" ? "streamable-http" : "stdio",
        ...(transport === "http" ? ["sse"] : []),
      ].includes(String(declared).toLowerCase())
    )
      throw invalid("Unsupported MCP transport");
    return {
      id,
      transport,
      auth: entry.auth ?? { kind: bearer ? "bearer" : "none", secretNames: [] },
      networkDomains:
        entry.networkDomains ??
        (typeof entry.url === "string" ? [new URL(entry.url).hostname] : []),
      ...(entry.startup_timeout_sec !== undefined || entry.startupTimeoutSec !== undefined
        ? {
            startupTimeoutSec: boundedStartupTimeout(
              entry.startup_timeout_sec ?? entry.startupTimeoutSec,
            ),
          }
        : {}),
      ...(transport === "http"
        ? {
            url: entry.url,
            headers: entry.headers ?? {},
            ...((String(declared).toLowerCase() === "sse" || entry.sseFallback === true) && {
              sseFallback: true,
            }),
          }
        : {
            command: entry.command,
            args: entry.args ?? [],
            env: entry.env ?? {},
            ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
          }),
    };
  });
  const digest = createHash("sha256").update(JSON.stringify(source)).digest("hex").slice(0, 16);
  return {
    schemaVersion: 1,
    id: `custom.${digest}`,
    version: "1.0.0",
    name: { zh: "自定义 MCP", en: "Custom MCP" },
    description: { zh: "从 MCP 配置导入", en: "Imported from MCP configuration" },
    servers: normalized,
  };
}

function boundedStartupTimeout(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    throw invalid("Invalid MCP startup timeout");
  return Math.min(value, 300);
}

function packageManagerDomains(command: string): readonly string[] {
  const executable = command
    .split(/[\\/]/)
    .at(-1)
    ?.toLowerCase()
    .replace(/\.cmd$/, "");
  return executable === "npx" || executable === "uvx" ? PACKAGE_MANAGER_DOMAINS[executable] : [];
}

function addPackageManagerDomains(manifest: ConnectorManifest): ConnectorManifest {
  return ConnectorManifestSchema.parse({
    ...manifest,
    servers: manifest.servers.map((server) =>
      server.transport === "stdio"
        ? {
            ...server,
            networkDomains: [
              ...new Set([...server.networkDomains, ...packageManagerDomains(server.command)]),
            ],
          }
        : server,
    ),
  });
}

export function normalizeConnectorSource(
  text: string,
  installationId?: string,
  finalValidation: FinalImportValidation = {},
): {
  manifest: ConnectorManifest;
  secrets: ImportedSecret[];
  digest: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid("Import source is not valid JSON");
  }
  const parsedManifest = ConnectorManifestSchema.safeParse(compatibleSource(parsed));
  if (!parsedManifest.success) throw invalid("Import source is not a valid connector manifest");
  const manifest = addPackageManagerDomains(parsedManifest.data);
  rejectCredentialMetadata([
    manifest.id,
    manifest.version,
    manifest.name.zh,
    manifest.name.en,
    manifest.description.zh,
    manifest.description.en,
    ...manifest.servers.flatMap((server) => [server.id, ...server.networkDomains]),
  ]);
  if (
    manifest.id.startsWith("pibot.") ||
    manifest.servers.some((server) => server.transport === "builtin")
  )
    throw invalid("Builtin drivers are available only from the trusted application catalog");
  const reserved = new Set<string>();
  for (const server of manifest.servers) {
    const values =
      server.transport === "stdio" ? server.env : server.transport === "http" ? server.headers : {};
    for (const value of Object.values(values))
      for (const match of value.matchAll(SECRET_REF_GLOBAL)) if (match[1]) reserved.add(match[1]);
    if (server.transport === "http")
      for (const match of server.url.matchAll(SECRET_REF_GLOBAL))
        if (match[1]) reserved.add(match[1]);
  }
  const prefix = installationId
    ? `IMPORT_${IdSchema.parse(installationId).replaceAll("-", "").toUpperCase()}_`
    : "";
  const registry = new ImportSecretRegistry(reserved, prefix);
  const servers = manifest.servers.map((server) => sanitizeServer(server, registry));
  const sanitized = recordFinalSecretReferences({ ...manifest, servers });
  validateFinalImportManifest(sanitized, finalValidation);
  const secrets = registry.entries();
  validateImportSecretLimit(sanitized, secrets);
  return {
    manifest: sanitized,
    secrets,
    digest: createHash("sha256").update(JSON.stringify(sanitized)).digest("hex"),
  };
}

export function importSecretPrefix(installationId: string) {
  return `IMPORT_${IdSchema.parse(installationId).replaceAll("-", "").toUpperCase()}_`;
}

function configSecretName(installationId: string, key: string) {
  return `${importSecretPrefix(installationId)}${key.toUpperCase()}`.slice(0, 64);
}

function configuredValue(
  field: ClaudePluginBundle["config"][number],
  values: Record<string, string | number | boolean>,
  preview: boolean,
) {
  const value = values[field.key] ?? field.default;
  if (value === undefined) {
    if (!preview && field.required) throw invalid(`Missing required plugin setting: ${field.key}`);
    if (!preview) return undefined;
    if (field.type === "number") return 0;
    if (field.type === "boolean") return false;
    return field.type === "string" ? "https://configured.invalid" : "configured-path";
  }
  if (field.type === "number" && typeof value !== "number")
    throw invalid(`Plugin setting ${field.key} must be a number`);
  if (field.type === "boolean" && typeof value !== "boolean")
    throw invalid(`Plugin setting ${field.key} must be a boolean`);
  if (!["number", "boolean"].includes(field.type) && typeof value !== "string")
    throw invalid(`Plugin setting ${field.key} must be text`);
  if (field.sensitive && typeof value !== "string")
    throw invalid(`Sensitive plugin setting ${field.key} must be text`);
  if (field.options && !field.options.some((option) => option.value === value))
    throw invalid(`Plugin setting ${field.key} has an unsupported option`);
  return value;
}

function configFieldVisible(
  field: ClaudePluginBundle["config"][number],
  values: Record<string, string | number | boolean>,
  fields: ReadonlyMap<string, ClaudePluginBundle["config"][number]>,
) {
  if (!field.visibleWhen) return true;
  // Non-UI callers (old clients and plugin_install) may omit the controlling field.
  // Evaluate the manifest default so the same branch is active everywhere.
  const controlling = fields.get(field.visibleWhen.key);
  const value = values[field.visibleWhen.key] ?? controlling?.default;
  return value === field.visibleWhen.equals;
}

function configureBundle(
  bundle: ClaudePluginBundle,
  installationId: string,
  values: Record<string, string | number | boolean>,
  preview: boolean,
  deferSensitive = false,
) {
  for (const source of Object.values(bundle.mcpServers)) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    const command = (source as Record<string, unknown>).command;
    if (typeof command === "string" && hasPluginCommandSubstitution(command))
      rejectCommandSubstitution();
  }
  const fields = new Map(bundle.config.map((field) => [field.key, field] as const));
  for (const key of Object.keys(values))
    if (!fields.has(key)) throw invalid(`Unknown plugin setting: ${key}`);
  const resolved = new Map<string, string>();
  const secrets: ImportedSecret[] = [];
  const secretNames = new Set<string>();
  const settings: Record<string, string | number | boolean> = {};
  const validateConfigured = new Set<string>();
  for (const field of bundle.config) {
    if (!configFieldVisible(field, values, fields)) {
      // Keep inactive placeholders empty so a manifest may declare both branches in one MCP env.
      resolved.set(field.key, "");
      continue;
    }
    if (deferSensitive && (field.sensitive || looksLikeCredentialName(field.key))) {
      if (Object.hasOwn(values, field.key) || field.default !== undefined)
        throw invalid("Sensitive plugin configuration must be filled in Connections");
      resolved.set(field.key, `\${secret:${configSecretName(installationId, field.key)}}`);
      continue;
    }
    const value = configuredValue(field, values, preview);
    if (value === undefined) {
      resolved.set(field.key, "");
      continue;
    }
    const sensitive = field.sensitive || looksLikeCredential(field.key, value);
    if (sensitive) {
      if (typeof value !== "string")
        throw invalid(`Sensitive plugin setting ${field.key} must be text`);
      const name = configSecretName(installationId, field.key);
      if (secretNames.has(name)) throw invalid("Plugin setting names collide after normalization");
      secretNames.add(name);
      resolved.set(field.key, `\${secret:${name}}`);
      if (!preview) secrets.push({ name, value });
    } else {
      resolved.set(field.key, String(value));
      if (!preview || field.default !== undefined) settings[field.key] = value;
    }
    if (Object.hasOwn(values, field.key) || field.default !== undefined)
      validateConfigured.add(field.key);
  }
  const substitutedStrings = new Set<string>();
  const replace = (value: unknown): unknown => {
    if (typeof value === "string") {
      let validateResult = false;
      const replaced = value.replace(
        /\$\{user_config\.([A-Za-z_][A-Za-z0-9_]*)\}|\$\{([A-Z][A-Z0-9_]*)\}/g,
        (match, userKey: string | undefined, envKey: string | undefined) => {
          const key = userKey ?? envKey;
          if (key && validateConfigured.has(key)) validateResult = true;
          return (key && resolved.get(key)) ?? match;
        },
      );
      if (validateResult && replaced !== value) substitutedStrings.add(replaced);
      return replaced;
    }
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
    return value;
  };
  const mcpServers = replace(bundle.mcpServers) as Record<string, unknown>;
  if (/\$\{user_config\.|\$\{[A-Z][A-Z0-9_]*\}/.test(JSON.stringify(mcpServers)))
    throw invalid("Plugin MCP references an undeclared setting");
  return { mcpServers, secrets, secretNames, settings, substitutedStrings };
}

function normalizeClaudePlugin(
  bundle: ClaudePluginBundle,
  installationId: string,
  values: Record<string, string | number | boolean>,
  preview: boolean,
  installationRoot?: string,
  deferSensitive = false,
) {
  const configured = configureBundle(bundle, installationId, values, preview, deferSensitive);
  const identity = createHash("sha256").update(JSON.stringify(bundle)).digest("hex").slice(0, 16);
  const normalized = Object.keys(configured.mcpServers).length
    ? normalizeConnectorSource(
        JSON.stringify({ mcpServers: configured.mcpServers }),
        installationId,
        {
          ...(installationRoot ? { installationRoot } : {}),
          substitutedStrings: configured.substitutedStrings,
        },
      )
    : {
        manifest: ConnectorManifestSchema.parse({
          schemaVersion: 1,
          id: `custom.${identity}`,
          version: bundle.version,
          name: { zh: bundle.name, en: bundle.name },
          description: { zh: bundle.description, en: bundle.description },
          servers: [],
        }),
        secrets: [],
        digest: "",
      };
  const manifest = ConnectorManifestSchema.parse({
    ...normalized.manifest,
    id: `custom.${identity}`,
    version: bundle.version,
    name: bundle.applicationCard?.name ?? { zh: bundle.name, en: bundle.name },
    description: bundle.applicationCard?.description ?? {
      zh: bundle.description,
      en: bundle.description,
    },
  });
  validateFinalImportManifest(manifest, {
    ...(installationRoot ? { installationRoot } : {}),
    substitutedStrings: configured.substitutedStrings,
  });
  validatePluginSecretNamespace(manifest, installationId);
  const secrets = [...normalized.secrets, ...configured.secrets];
  validateImportSecretLimit(manifest, secrets, configured.secretNames);
  return {
    manifest,
    secrets,
    settings: configured.settings,
    digest: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
  };
}

export function finalizeConnectorPreview(
  preview: ConnectorPreview,
  config: Record<string, string | number | boolean>,
  networkDomains: Readonly<Record<string, readonly string[]>> = {},
  deferSensitive = false,
) {
  const finalized = !preview.plugin
    ? {
        manifest: preview.manifest,
        secrets: preview.secrets,
        settings: {},
        digest: preview.digest,
      }
    : normalizeClaudePlugin(
        preview.plugin,
        preview.installationId,
        config,
        false,
        preview.installationRoot,
        deferSensitive,
      );
  assertConfirmedConnectionTargets(preview.manifest, finalized.manifest);
  const previewServers = new Map(preview.manifest.servers.map((server) => [server.id, server]));
  for (const [serverId, requested] of Object.entries(networkDomains)) {
    const server = previewServers.get(serverId);
    if (!server) throw invalid("Unknown server network selection");
    if (server.transport !== "stdio")
      throw invalid("Only sandboxed local server domains may be changed");
    const selected = new Set(requested);
    if (selected.size !== requested.length) throw invalid("Duplicate server network selection");
    if ([...selected].some((domain) => !server.networkDomains.includes(domain)))
      throw invalid("Network selection may only remove previewed domains");
  }
  if (Object.keys(networkDomains).length === 0) return finalized;
  const manifest = ConnectorManifestSchema.parse({
    ...finalized.manifest,
    servers: finalized.manifest.servers.map((server) => {
      const requested = networkDomains[server.id];
      if (!requested) return server;
      const selected = new Set(requested);
      return {
        ...server,
        networkDomains: server.networkDomains.filter((domain) => selected.has(domain)),
      };
    }),
  });
  return {
    ...finalized,
    manifest,
    digest: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
  };
}

function confirmedConnectionTarget(server: ConnectorServer): unknown {
  if (server.transport === "http")
    return {
      id: server.id,
      transport: server.transport,
      url: server.url,
      sseFallback: server.sseFallback === true,
      ...(server.startupTimeoutSec !== undefined
        ? { startupTimeoutSec: server.startupTimeoutSec }
        : {}),
      networkDomains: server.networkDomains,
    };
  if (server.transport === "stdio")
    return {
      id: server.id,
      transport: server.transport,
      command: server.command,
      args: server.args,
      ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
      ...(server.startupTimeoutSec !== undefined
        ? { startupTimeoutSec: server.startupTimeoutSec }
        : {}),
      networkDomains: server.networkDomains,
    };
  return {
    id: server.id,
    transport: server.transport,
    builtinId: server.builtinId,
    networkDomains: server.networkDomains,
  };
}

function assertConfirmedConnectionTargets(
  preview: ConnectorManifest,
  finalized: ConnectorManifest,
): void {
  const confirmed = preview.servers.map(confirmedConnectionTarget);
  const target = finalized.servers.map(confirmedConnectionTarget);
  if (JSON.stringify(confirmed) !== JSON.stringify(target))
    throw invalid("Plugin settings changed connection targets; refresh the preview");
}

/** Preview is short-lived and single-use: import must consume the same snapshot. */
export class ConnectorPreviewStore {
  private readonly entries = new Map<string, ConnectorPreview & { expires: number }>();
  private readonly receipts = new Map<string, ConnectorImportReceipt & { expires: number }>();
  private readonly receiptKey = randomBytes(32);

  private intentDigest(intent: ConnectorImportIntent): string {
    const config = Object.fromEntries(
      Object.entries(intent.config).sort(([left], [right]) => left.localeCompare(right)),
    );
    return createHmac("sha256", this.receiptKey)
      .update(
        JSON.stringify({
          enable: intent.enable,
          config,
          skillTargets: {
            bots: [...new Set(intent.skillTargets?.bots ?? [])].sort(),
            groups: [...new Set(intent.skillTargets?.groups ?? [])].sort(),
          },
        }),
      )
      .digest("hex");
  }

  private prune(now: number): void {
    for (const [id, entry] of this.entries) if (entry.expires <= now) this.entries.delete(id);
    for (const [id, receipt] of this.receipts) if (receipt.expires <= now) this.receipts.delete(id);
  }

  create(
    text: string,
    sourceKind: "json" | "plugin",
    now = Date.now(),
    installationId = randomUUID(),
    installationRoot?: string,
  ): ConnectorPreview {
    this.prune(now);
    if (this.entries.size >= 64) throw invalid("Too many pending previews");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw invalid("Import source is not valid JSON");
    }
    let plugin: ClaudePluginBundle | undefined;
    if (sourceKind === "plugin") {
      const bundle = ClaudePluginBundleSchema.safeParse(parsed);
      if (!bundle.success) throw invalid("Invalid Claude Code plugin bundle");
      rejectCredentialMetadata([
        bundle.data.name,
        bundle.data.version,
        bundle.data.description,
        ...bundle.data.skills.flatMap((skill) => [skill.id, skill.name, skill.description]),
        ...bundle.data.config.flatMap((field) => [field.key, field.title, field.description]),
        ...bundle.data.components.flatMap((component) => [component.name, component.path ?? ""]),
      ]);
      plugin = {
        ...bundle.data,
        config: bundle.data.config.map(hardenPluginConfigField),
      };
    }
    const normalized = plugin
      ? normalizeClaudePlugin(plugin, installationId, {}, true, installationRoot)
      : normalizeConnectorSource(text, installationId);
    const preview = {
      previewId: randomUUID(),
      installationId,
      digest: plugin ? createHash("sha256").update(text).digest("hex") : normalized.digest,
      expiresAt: new Date(now + PREVIEW_TTL_MS).toISOString(),
      manifest: normalized.manifest,
      ...(plugin
        ? plugin.versionDeclared
          ? { declaredVersion: normalized.manifest.version }
          : {}
        : parsed !== null &&
            typeof parsed === "object" &&
            "schemaVersion" in parsed &&
            parsed.schemaVersion === 1 &&
            "version" in parsed
          ? { declaredVersion: normalized.manifest.version }
          : {}),
      secrets: normalized.secrets,
      ...(plugin ? { plugin } : {}),
      ...(installationRoot ? { installationRoot } : {}),
    };
    this.entries.set(preview.previewId, { ...preview, expires: now + PREVIEW_TTL_MS });
    return preview;
  }

  /** Replaces a plugin preview with one evaluated from current settings, without retaining them. */
  configure(
    previewId: string,
    config: Record<string, string | number | boolean>,
    now = Date.now(),
  ): ConnectorPreview {
    const current = this.take(previewId, now);
    if (!current.plugin) throw invalid("Only plugin previews have configurable settings");
    const normalized = normalizeClaudePlugin(
      current.plugin,
      current.installationId,
      config,
      false,
      current.installationRoot,
    );
    const configured: ConnectorPreview = {
      previewId: randomUUID(),
      installationId: current.installationId,
      digest: normalized.digest,
      // Refreshing settings must not extend the source selection capability lifetime.
      expiresAt: current.expiresAt,
      manifest: normalized.manifest,
      ...(current.declaredVersion ? { declaredVersion: current.declaredVersion } : {}),
      // Final import re-evaluates the same settings; never retain submitted secret values here.
      secrets: [],
      plugin: current.plugin,
      ...(current.installationRoot ? { installationRoot: current.installationRoot } : {}),
    };
    this.entries.delete(current.previewId);
    this.entries.set(configured.previewId, {
      ...configured,
      expires: Date.parse(configured.expiresAt),
    });
    return configured;
  }

  /** Read-only until commit replaces this entry with a plaintext-free retry receipt. */
  take(previewId: string, now = Date.now()): ConnectorPreview {
    const id = IdSchema.parse(previewId);
    const entry = this.entries.get(id);
    if (!entry) throw invalid("Preview not found");
    if (entry.expires <= now) {
      this.entries.delete(id);
      throw invalid("Preview expired");
    }
    return entry;
  }

  /** Read the normalized preview while keeping the single-use entry available for commit. */
  peek(previewId: string, now = Date.now()): ConnectorPreview {
    return this.take(previewId, now);
  }

  committed(
    previewId: string,
    intent: ConnectorImportIntent,
    now = Date.now(),
  ): ConnectorImportReceipt | undefined {
    this.prune(now);
    const receipt = this.receipts.get(IdSchema.parse(previewId));
    if (!receipt) return undefined;
    const expected = Buffer.from(this.intentDigest(intent), "hex");
    const actual = Buffer.from(receipt.intentDigest, "hex");
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected))
      throw invalid("Import request changed; re-run the import");
    return receipt;
  }

  commit(
    preview: Pick<ConnectorPreview, "previewId" | "installationId" | "digest">,
    intent: ConnectorImportIntent,
    now = Date.now(),
  ): ConnectorImportReceipt {
    const id = IdSchema.parse(preview.previewId);
    const receipt = {
      previewId: id,
      installationId: IdSchema.parse(preview.installationId),
      digest: preview.digest,
      intentDigest: this.intentDigest(intent),
      expiresAt: new Date(now + PREVIEW_TTL_MS).toISOString(),
    };
    this.entries.delete(id);
    this.receipts.set(id, { ...receipt, expires: now + PREVIEW_TTL_MS });
    return receipt;
  }

  cancel(previewId: string): void {
    const id = IdSchema.parse(previewId);
    this.entries.delete(id);
    this.receipts.delete(id);
  }
}
