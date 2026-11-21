import { createPrivateKey } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { CloudMaterial } from "@pibot/agent";
import { abortable, endpoint } from "@pibot/brain/kit";
import { type CloudConfig, CloudCredentialsSchema, RpcError } from "@pibot/models-contract/full";
import { z } from "zod";

const field = z.string().min(1).max(20000);
const serviceAccount = z.object({
  type: z.literal("service_account"),
  project_id: z.string().regex(/^[a-z][a-z0-9-]{4,62}$/),
  client_email: z.email(),
  private_key: field.refine((v) => /^-----BEGIN PRIVATE KEY-----\n/.test(v)),
  private_key_id: field.optional(),
  token_uri: z.literal("https://oauth2.googleapis.com/token").optional(),
});
const adc = z.union([
  serviceAccount,
  z.object({
    type: z.literal("authorized_user"),
    client_id: field,
    client_secret: field,
    refresh_token: field,
  }),
]);
const segment = /^[A-Za-z0-9_-]{1,200}$/;
export async function credentialFile(file: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    signal.throwIfAborted();
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1048576)
      throw new RpcError(-32602, "credential_file_too_large");
    const buffer = Buffer.alloc(1048577);
    const { bytesRead } = await abortable(handle.read(buffer, 0, buffer.length, 0), signal);
    signal.throwIfAborted();
    if (bytesRead > 1048576) throw new RpcError(-32602, "credential_file_too_large");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}
function staticProfile(text: string, profile: string): Record<string, string> {
  const sections = new Map<string, Record<string, string>>();
  let section: Record<string, string> | undefined;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^[#;]/.test(trimmed)) continue;
    const header = /^\[(.*?)\]$/.exec(trimmed);
    if (header) {
      const name = (header[1] ?? "").replace(/^profile /, "");
      section = sections.get(name) ?? {};
      sections.set(name, section);
    } else if (section) {
      const assignment = /^([^=]+)=(.*)$/.exec(trimmed);
      if (!assignment) throw new RpcError(-32602, "unsupported_profile");
      const key = (assignment[1] ?? "").trim().toLowerCase();
      if (Object.hasOwn(section, key)) throw new RpcError(-32602, "unsupported_profile");
      section[key] = (assignment[2] ?? "").trim();
    }
  }
  return sections.get(profile) ?? {};
}
export async function prepareCloud(
  input: z.infer<typeof CloudCredentialsSchema>,
  options: { home: string; platform: string; appData?: string },
  signal: AbortSignal,
): Promise<{ config: CloudConfig; material: CloudMaterial }> {
  const p = CloudCredentialsSchema.parse(input);
  const material: CloudMaterial = { providerId: p.providerId, env: {} };
  let config: CloudConfig;
  if (p.providerId === "amazon-bedrock") {
    if (!/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(p.region))
      throw new RpcError(-32602, "invalid_region");
    let keys: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
    if (p.auth.kind === "profile") {
      if (!segment.test(p.auth.profile)) throw new RpcError(-32602, "invalid_profile");
      const configText = await credentialFile(join(options.home, ".aws", "config"), signal).catch(
        (e: NodeJS.ErrnoException) => {
          if (e.code === "ENOENT") return "";
          throw e;
        },
      );
      const profile = {
        ...staticProfile(configText, p.auth.profile),
        ...staticProfile(
          await credentialFile(join(options.home, ".aws", "credentials"), signal),
          p.auth.profile,
        ),
      };
      if (
        Object.keys(profile).some(
          (k) =>
            ![
              "aws_access_key_id",
              "aws_secret_access_key",
              "aws_session_token",
              "region",
              "output",
            ].includes(k),
        )
      )
        throw new RpcError(-32602, "unsupported_profile");
      keys = {
        accessKeyId: profile.aws_access_key_id ?? "",
        secretAccessKey: profile.aws_secret_access_key ?? "",
        sessionToken: profile.aws_session_token,
      };
      config = {
        providerId: p.providerId,
        region: p.region,
        mode: "profile",
        profile: p.auth.profile,
      };
    } else {
      keys = p.auth;
      config = { providerId: p.providerId, region: p.region, mode: "keys" };
    }
    const valid = CloudCredentialsSchema.parse({
      providerId: p.providerId,
      region: p.region,
      auth: { kind: "keys", ...keys },
    });
    if (valid.providerId !== "amazon-bedrock" || valid.auth.kind !== "keys")
      throw new RpcError(-32602, "invalid_credentials");
    material.env = {
      AWS_REGION: p.region,
      AWS_ACCESS_KEY_ID: valid.auth.accessKeyId,
      AWS_SECRET_ACCESS_KEY: valid.auth.secretAccessKey,
      ...(valid.auth.sessionToken ? { AWS_SESSION_TOKEN: valid.auth.sessionToken } : {}),
    };
  } else if (p.providerId === "google-vertex") {
    if (!segment.test(p.project) || !segment.test(p.location))
      throw new RpcError(-32602, "invalid_vertex_config");
    const text =
      p.auth.kind === "serviceAccount"
        ? p.auth.serviceAccountJson
        : await credentialFile(
            options.platform === "win32"
              ? join(
                  options.appData ?? join(options.home, "AppData", "Roaming"),
                  "gcloud",
                  "application_default_credentials.json",
                )
              : join(options.home, ".config", "gcloud", "application_default_credentials.json"),
            signal,
          );
    if (Buffer.byteLength(text, "utf8") > 1048576)
      throw new RpcError(-32602, "credential_file_too_large");
    // Strip unrelated fields: external-account, impersonation and custom token endpoints never reach Google Auth.
    const raw = JSON.parse(text);
    if (
      raw.service_account_impersonation_url ||
      raw.credential_source ||
      (raw.universe_domain && raw.universe_domain !== "googleapis.com")
    )
      throw new RpcError(-32602, "unsupported_adc");
    const credentials =
      p.auth.kind === "serviceAccount" ? serviceAccount.parse(raw) : adc.parse(raw);
    if (
      credentials.type === "service_account" &&
      createPrivateKey(credentials.private_key).asymmetricKeyType !== "rsa"
    )
      throw new RpcError(-32602, "invalid_service_account_key");
    material.googleCredentials = credentials;
    material.env = { GOOGLE_CLOUD_PROJECT: p.project, GOOGLE_CLOUD_LOCATION: p.location };
    config = {
      providerId: p.providerId,
      project: p.project,
      location: p.location,
      mode: p.auth.kind,
    };
  } else if (p.providerId === "azure") {
    if (
      !segment.test(p.apiVersion) ||
      Object.entries(p.deployments).some(
        ([model, deployment]) =>
          !/^[A-Za-z0-9_.:/-]{1,200}$/.test(model) || !/^[A-Za-z0-9_.-]{1,200}$/.test(deployment),
      )
    )
      throw new RpcError(-32602, "invalid_deployment_mapping");
    config = {
      providerId: p.providerId,
      endpoint: endpoint(p.endpoint),
      apiVersion: p.apiVersion,
      deployments: p.deployments,
    };
    material.apiKey = p.apiKey;
    material.env = {
      AZURE_OPENAI_BASE_URL: config.endpoint,
      AZURE_OPENAI_API_VERSION: p.apiVersion,
      AZURE_OPENAI_DEPLOYMENT_NAME_MAP: Object.entries(p.deployments)
        .map(([m, d]) => `${m}=${d}`)
        .join(","),
    };
  } else {
    if (
      !segment.test(p.accountId) ||
      (p.providerId === "cloudflare-ai-gateway" && !segment.test(p.gatewayId))
    )
      throw new RpcError(-32602, "invalid_cloudflare_config");
    material.apiKey = p.apiToken;
    material.env = {
      CLOUDFLARE_ACCOUNT_ID: p.accountId,
      ...(p.providerId === "cloudflare-ai-gateway" ? { CLOUDFLARE_GATEWAY_ID: p.gatewayId } : {}),
    };
    config = {
      providerId: p.providerId,
      accountId: p.accountId,
      ...(p.providerId === "cloudflare-ai-gateway" ? { gatewayId: p.gatewayId } : {}),
    } as CloudConfig;
  }
  signal.throwIfAborted();
  return { config, material };
}
