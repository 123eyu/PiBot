/** Loaded by sandbox-host under strip-only Node; no imports with runtime dependencies. */
export interface HostSshCommand {
  hostname: string;
  user: string;
  port: number;
  identity: string;
  knownHosts: string;
  remoteCommand: string;
  /** Seconds; the fixed default stays 15. */
  connectTimeout?: number;
  quiet?: boolean;
}

const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;

/** Constant shell code, carried in argv rather than any project-writable script file. */
function proxyCommand(port: number) {
  const setup = [
    "LC_ALL=C",
    'case "$1" in ""|*[!A-Za-z0-9.-]*) exit 1;; esac',
    'case "$2" in ""|*[!0-9]*) exit 1;; esac',
    "exec 3<&0",
  ].join("; ");
  const bridge =
    // biome-ignore lint/suspicious/noTemplateCurlyInString: The fixed shell expands only the host-injected proxy capability.
    '{ printf "CONNECT %s:%s HTTP/1.1\\r\\nHost: %s:%s\\r\\nProxy-Authorization: Basic %s\\r\\n\\r\\n" "$1" "$2" "$1" "$2" "${PIBOT_HOST_SSH_PROXY_AUTH:?}"; exec /bin/cat <&3; } | ' +
    `/usr/bin/nc 127.0.0.1 ${port} | ` +
    '{ IFS=" " read -r version status rest; [ "$status" = 200 ] || exit 1; ' +
    'while IFS= read -r line; do case "$line" in ""|?) break;; esac; done; exec /bin/cat; }';
  const script = `${setup}; ${bridge} & exec >&-; wait $!`;
  // OpenSSH expands percent tokens before running its ProxyCommand shell. Only the two
  // explicit positional arguments below may expand; printf/parameter syntax stays literal.
  return `/bin/sh -c ${quote(script.replaceAll("%", "%%"))} sh '%h' %p`;
}

/** Only this trusted bridge knows SRT's ephemeral port. User ProxyCommand is never accepted. */
export function fixedHostSshCommand(input: HostSshCommand, httpPort: number) {
  if (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535)
    throw new Error("invalid_proxy");
  const argv = [
    "/usr/bin/ssh",
    "-F",
    "/dev/null",
    "-T",
    "-n",
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "IdentityAgent=none",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "UpdateHostKeys=no",
    "-o",
    "CheckHostIP=no",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "SendEnv=-*",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ControlPersist=no",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "CanonicalizeHostname=no",
    "-o",
    "PKCS11Provider=none",
    "-o",
    "SecurityKeyProvider=none",
    ...(input.quiet ? ["-q"] : []),
    "-o",
    `ConnectTimeout=${input.connectTimeout ?? 15}`,
    "-o",
    "ConnectionAttempts=1",
    // ConnectTimeout only covers reaching the host. Without keepalives a connected but wedged
    // session runs into the command timeout, so ask for a reply every 15 s and give up after four
    // missed ones (~60 s). An idle but healthy session answers the keepalive, so long commands
    // are unaffected.
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=4",
    "-o",
    `ProxyCommand=${proxyCommand(httpPort)}`,
    "-o",
    `UserKnownHostsFile="${input.knownHosts.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
    "-i",
    input.identity,
    "-p",
    String(input.port),
    "-l",
    input.user,
    "--",
    input.hostname,
    input.remoteCommand,
  ];
  // SSH mixes local authentication diagnostics and remote stderr. Suppress both in v1 instead
  // of ever persisting credential paths or local configuration diagnostics in a command log.
  return `exec ${argv.map(quote).join(" ")} 2>/dev/null`;
}
