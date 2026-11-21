import type { CommandAnalysis } from "../core/types.ts";

// No Node builtins here: intrinsic decisions are also the phone's portable policy.

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
function ipv4(host: string): number[] | undefined {
  const match = IPV4.exec(host);
  if (!match) return undefined;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : undefined;
}
const ipv6 = (host: string) => host.includes(":") && /^[0-9a-f:.]+$/.test(host);
export const isIpLiteral = (host: string) => !!ipv4(host) || ipv6(host);

const bare = (host: string) =>
  host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");

/**
 * Maintainers 2026-11-14 ("ask each time"): the user's own network (a router's admin page, a device
 * being debugged) is reachable after a card per target and task: 10/8, 172.16/12, 192.168/16,
 * link-local, IPv6 ULA / link-local and mDNS `.local` names. Loopback is not part of it: the
 * Bot's own services keep their exception and everything else on loopback stays refused.
 */
export function privateNetworkHost(raw: string): string | undefined {
  const host = bare(raw);
  if (!host || host.length > 253 || /[\s/@%]/u.test(host)) return undefined;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host)?.[1];
  const v4 = ipv4(mapped ?? host);
  if (v4) {
    const [a = 0, b = 0] = v4;
    const local =
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254);
    return local ? host : undefined;
  }
  if (ipv6(host)) return /^(?:f[cd][0-9a-f]{0,2}|fe[89ab][0-9a-f]?):/.test(host) ? host : undefined;
  // mDNS names are always on the local link; one label before ".local" at least.
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+local$/.test(host) ? host : undefined;
}

/** `http://192.168.1.1/x` → `http://192.168.1.1:80`; ws(s) count as the page's own origin. */
export function privateNetworkOrigin(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const scheme =
    parsed.protocol === "ws:" ? "http:" : parsed.protocol === "wss:" ? "https:" : parsed.protocol;
  if (scheme !== "http:" && scheme !== "https:") return undefined;
  const host = privateNetworkHost(parsed.hostname);
  if (!host) return undefined;
  const port = parsed.port || (scheme === "https:" ? "443" : "80");
  return `${scheme}//${ipv6(host) ? `[${host}]` : host}:${port}`;
}

/** Programs whose bare operands are hosts (`ping router.local`, `nc 10.0.0.2 80`). */
const NETWORK_PROGRAMS = new Set([
  "curl",
  "wget",
  "ping",
  "ping6",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "nc",
  "ncat",
  "netcat",
  "telnet",
  "nmap",
  "traceroute",
  "traceroute6",
  "tracepath",
  "mtr",
  "dig",
  "nslookup",
  "host",
  "arping",
  "iperf",
  "iperf3",
  "ftp",
  "http",
  "xh",
  "mosquitto_pub",
  "mosquitto_sub",
  "snmpget",
  "snmpwalk",
  "adb",
]);

export function isNetworkProgram(program: string) {
  const name = (program.split(/[\\/]/).at(-1) ?? program).toLowerCase().replace(/\.exe$/, "");
  return NETWORK_PROGRAMS.has(name);
}

/**
 * The host a command word names: a URL, `user@host[:path]`, `host:port`, or (for a network
 * program's operands) a bare host. A bare word elsewhere is a file name as often as a host
 * (`config.local`), so only an IP literal counts there.
 */
function wordHost(word: string, networkProgram: boolean): string | undefined {
  const value = word.trim();
  if (!value || value.length > 2048) return undefined;
  if (value.startsWith("-")) {
    const option = /^--?[\w-]+=(.+)$/.exec(value)?.[1];
    return option ? wordHost(option, networkProgram) : undefined;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      return new URL(value).hostname || undefined;
    } catch {
      return undefined;
    }
  }
  const at = value.lastIndexOf("@");
  const rest = at >= 0 ? value.slice(at + 1) : value;
  const bracket = /^\[([^\]]+)\]/.exec(rest)?.[1];
  if (bracket) return bracket;
  // An IPv6 literal without brackets has several colons; host:port / host:path has one.
  const host = (rest.match(/:/g) ?? []).length > 1 ? rest.split("%")[0] : rest.split(/[:/]/)[0];
  const marked = at >= 0 || /^[^:/]+:\d{1,5}$/.test(rest);
  return host && (networkProgram || marked || isIpLiteral(host.toLowerCase())) ? host : undefined;
}

/**
 * The local-network hosts a command names in its words (and the domains analysis found), so its
 * card can say where it goes. A host reached only through a name that resolves privately is not
 * seen here; the sandbox proxy still refuses it until the user approves that host.
 */
export function privateCommandHosts(analysis: CommandAnalysis | undefined): string[] {
  if (!analysis) return [];
  const hosts = new Set<string>();
  const add = (candidate: string | undefined) => {
    const host = candidate ? privateNetworkHost(candidate) : undefined;
    if (host) hosts.add(host);
  };
  for (const domain of analysis.domains) add(domain);
  for (const { program, args } of analysis.commands) {
    const name = (program.split(/[\\/]/).at(-1) ?? program).toLowerCase().replace(/\.exe$/, "");
    const networkProgram = NETWORK_PROGRAMS.has(name);
    for (const arg of args) add(wordHost(arg, networkProgram));
  }
  return [...hosts].sort().slice(0, 16);
}
