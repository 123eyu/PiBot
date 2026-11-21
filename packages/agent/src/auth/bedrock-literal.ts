import type { Provider, StreamOptions } from "@earendil-works/pi-ai";
import { resolveHttpProxyUrlForTarget } from "@earendil-works/pi-ai/utils/node-http-proxy";
import { AgentError } from "../core/errors.ts";

export function literalBedrock(provider: Provider): Provider {
  function request<T extends Parameters<Provider["streamSimple"]>[0]>(
    model: T,
    options?: StreamOptions,
  ) {
    const env = { ...options?.env };
    const region = env.AWS_REGION;
    if (
      !region ||
      !/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(region) ||
      !env.AWS_ACCESS_KEY_ID ||
      !env.AWS_SECRET_ACCESS_KEY
    )
      throw new Error("Explicit AWS credentials required");
    // Suppress the SDK's region-based endpoint discovery so shared config cannot redirect
    // signed requests. The native adapter infers the region from this pinned endpoint.
    delete env.AWS_REGION;
    delete env.AWS_DEFAULT_REGION;
    delete env.AWS_PROFILE;
    env.AWS_BEDROCK_SKIP_AUTH = "0";
    const baseUrl = `https://bedrock-runtime.${region}.amazonaws.com${region.startsWith("cn-") ? ".cn" : ""}`;
    // The AWS SDK bypasses fetch: with a manual proxy, refuse unless pi will tunnel this exact
    // endpoint through it (a stray NO_PROXY would otherwise send it directly).
    if (
      env.HTTPS_PROXY &&
      resolveHttpProxyUrlForTarget(baseUrl, env)?.href !== new URL(env.HTTPS_PROXY).href
    )
      throw new AgentError("proxy_unsupported");
    return {
      model: { ...model, baseUrl },
      options: {
        ...options,
        env,
        region: undefined,
        profile: undefined,
        bearerToken: undefined,
        apiKey: undefined,
      },
    };
  }
  return {
    ...provider,
    stream(model, context, options) {
      const prepared = request(model, options);
      return provider.stream(prepared.model, context, prepared.options as typeof options);
    },
    streamSimple(model, context, options) {
      const prepared = request(model, options);
      return provider.streamSimple(prepared.model, context, prepared.options as typeof options);
    },
  };
}
