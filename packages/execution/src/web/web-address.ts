import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { ExecError } from "../core/types.ts";

export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (!version) return false;
  if (version === 6) {
    // Mapped IPv4 must pass the IPv4 rules, not bypass them as a seemingly different family.
    const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/i.exec(address);
    if (mapped) {
      const high = Number.parseInt(mapped[1] as string, 16);
      const low = Number.parseInt(mapped[2] as string, 16);
      return isPublicAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    if (address.toLowerCase().startsWith("::ffff:")) return isPublicAddress(address.slice(7));
    const publicRange = new BlockList();
    publicRange.addSubnet("2000::", 3, "ipv6");
    const denied = new BlockList();
    denied.addSubnet("2001::", 32, "ipv6");
    denied.addSubnet("2001:db8::", 32, "ipv6");
    denied.addSubnet("2002::", 16, "ipv6");
    return publicRange.check(address, "ipv6") && !denied.check(address, "ipv6");
  }
  const denied = new BlockList();
  for (const [subnet, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const)
    denied.addSubnet(subnet, prefix);
  return !denied.check(address);
}

export function checkedUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ExecError("web_blocked", "unsupported_url");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    host.endsWith(".") ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "local" ||
    host.endsWith(".local")
  )
    throw new ExecError("web_blocked", "unsupported_url");
  if (isIP(host) && !isPublicAddress(host)) throw new ExecError("web_blocked", "private_address");
  url.hash = "";
  return url;
}

export function waitForWeb<T>(operation: Promise<T> | T, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(new ExecError("web_failed", "cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    const cleanup = () => signal.removeEventListener("abort", abort);
    void Promise.resolve(operation).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}

export async function publicAddresses(url: URL, signal: AbortSignal) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  signal.throwIfAborted();
  const family = isIP(hostname);
  if (family) return [{ address: hostname, family }];
  // DNS itself is not cancellable; bound its caller while ignoring any late completion.
  const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new ExecError("web_failed", "cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void lookup(hostname, { all: true, verbatim: true })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
  const list = Array.isArray(addresses) ? addresses : [addresses];
  // Clash fake-IP is permitted only as a DNS answer; checkedUrl still rejects literal addresses.
  const fakeIp = new BlockList();
  fakeIp.addSubnet("198.18.0.0", 15);
  if (
    !list.length ||
    list.some(({ address }) => !isPublicAddress(address) && !fakeIp.check(address))
  )
    throw new ExecError("web_blocked", "private_address");
  return list;
}

/** Proxy resolves the public hostname; local failures cannot force direct DNS transport. */
export async function checkProxyTarget(url: URL, signal: AbortSignal): Promise<void> {
  checkedUrl(url.href);
  if (isIP(url.hostname.replace(/^\[|\]$/g, ""))) return;
  try {
    await publicAddresses(url, AbortSignal.any([signal, AbortSignal.timeout(2000)]));
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ExecError && error.reason === "private_address") throw error;
    // DNS failures and polluted public answers are not proxy routing decisions.
  }
}

/**
 * A URL another fetcher will request on Pi Bot's behalf (an MCP fetch server picked as the
 * web.fetch implementation) gets the same target check as fetchPage's first hop: no private or
 * loopback literal, no hostname resolving to one. DNS failures do not block, as behind a proxy.
 * The other fetcher's own redirects are outside Pi Bot's control.
 */
export async function assertPublicWebTarget(input: string, signal: AbortSignal): Promise<void> {
  await checkProxyTarget(checkedUrl(input), signal);
}
