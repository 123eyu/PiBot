const PROXY_NAME = /^(?:https?_proxy|all_proxy)$/i;

/** Only endpoint URLs inherit from the host, never proxy accounts or URL-carried tokens. */
export function connectorProxyEnvironment(original: Readonly<NodeJS.ProcessEnv>) {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(original)) {
    if (!PROXY_NAME.test(name) || !value || value.length > 2048 || /[\s\0]/.test(value)) continue;
    try {
      const url = new URL(value);
      if (
        !new Set(["http:", "https:", "socks:", "socks4:", "socks5:", "socks5h:"]).has(
          url.protocol,
        ) ||
        !url.hostname ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.pathname && url.pathname !== "/") ||
        value.includes("@")
      )
        continue;
      env[name] = value;
    } catch {
      // A malformed proxy cannot be safely interpreted as a credential-free endpoint.
    }
  }
  return env;
}

export function withoutConnectorProxyEnvironment(original: Readonly<NodeJS.ProcessEnv>) {
  return Object.fromEntries(Object.entries(original).filter(([name]) => !PROXY_NAME.test(name)));
}
