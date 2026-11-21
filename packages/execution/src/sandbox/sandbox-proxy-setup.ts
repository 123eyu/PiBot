// No imports on purpose: the sandbox host process (sandbox-host.ts) loads this from source under
// plain Node in development, where only erasable TypeScript syntax is accepted.

const proxyUrls = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "GRPC_PROXY",
  "grpc_proxy",
  "FTP_PROXY",
  "ftp_proxy",
  "DOCKER_HTTP_PROXY",
  "DOCKER_HTTPS_PROXY",
] as const;

export function validProxyPort(port: number | undefined): port is number {
  return Number.isInteger(port) && (port as number) > 0 && (port as number) <= 65535;
}

/**
 * SRT 0.0.79 advertises localhost although its mux listens only on IPv4. Shell lines that run
 * inside the SDK wrapper, after its env is installed, and rewrite only SRT's own listener
 * addresses; user command literals and attribution stay intact.
 */
export function sandboxProxySetup(httpPort: number, socksPort: number): string {
  const setup = proxyUrls.flatMap((name) =>
    [...new Set([httpPort, socksPort])].map(
      (port) =>
        `if [ "\${${name}+x}" = x ]; then export ${name}="\${${name}/%localhost:${port}/127.0.0.1:${port}}"; fi`,
    ),
  );
  setup.push(
    `if [ "\${RSYNC_PROXY+x}" = x ]; then export RSYNC_PROXY="\${RSYNC_PROXY/#localhost:${socksPort}/127.0.0.1:${socksPort}}"; fi`,
    `if [ "\${CLOUDSDK_PROXY_ADDRESS-}" = localhost ] && [ "\${CLOUDSDK_PROXY_PORT-}" = ${httpPort} ]; then export CLOUDSDK_PROXY_ADDRESS=127.0.0.1; fi`,
    `if [ "\${GIT_SSH_COMMAND+x}" = x ]; then export GIT_SSH_COMMAND="\${GIT_SSH_COMMAND/-x localhost:${socksPort} /-x 127.0.0.1:${socksPort} }"; fi`,
  );
  // NO_PROXY describes destinations, not the SDK listener. JVM's SDK agent reads these URLs.
  return setup.join("\n");
}
