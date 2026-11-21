import { join } from "node:path";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { providerEnvNames } from "../models/catalog.ts";

// The public mapping omits cloud credentials and request configuration. Keep the source-audited
// supplement from T2, including old Appendix A names, when upgrading the locked SDK.
const auditedNames = [
  "PI_PACKAGE_DIR",
  "PI_SHARE_VIEWER_URL",
  "PI_OAUTH_CALLBACK_HOST",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_USE_ENV_PROXY",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_BEDROCK_SKIP_AUTH",
  "AWS_ENDPOINT_URL",
  "AWS_ENDPOINT_URL_BEDROCK",
  "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_SERVICE_ACCOUNT_ID",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_WORKSPACE_ID",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONFIG_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_VERTEX_BASE_URL",
  "GOOGLE_GEMINI_BASE_URL",
  "GOOGLE_CLOUD_API_KEY",
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_GATEWAY_ID",
  "AZURE_OPENAI_BASE_URL",
  "AZURE_OPENAI_RESOURCE_NAME",
  "AZURE_OPENAI_API_VERSION",
  "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
  "GH_TOKEN",
  "GITHUB_TOKEN",
];
export const BRAIN_AUTH_ENV_NAMES: readonly string[] = Object.freeze(
  [
    ...new Set([
      ...builtinProviders().flatMap((provider) => providerEnvNames(provider.id)),
      ...auditedNames,
    ]),
  ].sort(),
);

export function sanitizeBrainEnv(env: NodeJS.ProcessEnv, dataDir?: string): void {
  const directory = dataDir ?? env.PIBOT_DATA_DIR;
  if (!directory) throw new TypeError("Pi Bot dataDir is required to isolate pi");
  const names = new Set(BRAIN_AUTH_ENV_NAMES);
  // Windows environment names are case insensitive, including in plain test dictionaries.
  for (const name of Object.keys(env)) {
    const upper = name.toUpperCase();
    if (
      names.has(upper) ||
      upper === "PI_CODING_AGENT_DIR" ||
      upper === "PI_CODING_AGENT_SESSION_DIR" ||
      upper === "PI_OFFLINE" ||
      upper === "PI_SKIP_VERSION_CHECK" ||
      upper === "PI_TELEMETRY"
    )
      delete env[name];
  }
  env.PI_OFFLINE = "1";
  env.PI_SKIP_VERSION_CHECK = "1";
  env.PI_TELEMETRY = "0";
  env.PI_CODING_AGENT_DIR = join(directory, "pi");
}
