import { networkInterfaces } from "node:os";

const ipv4 = (value: string) => {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255))
    return undefined;
  return parts.reduce((result, part) => (result * 256 + Number(part)) >>> 0, 0);
};

/** Interface presence is a diagnostic hint, never proof of the selected OS route. */
export function desktopNetworkHint(remoteHosts: readonly string[]) {
  const interfaces = Object.values(networkInterfaces()).flatMap((items) => items ?? []);
  const locals = interfaces.filter((item) => !item.internal && item.family === "IPv4");
  if (
    locals.some((item) => {
      const address = ipv4(item.address);
      return address !== undefined && address >>> 17 === 0xc6120000 >>> 17;
    })
  )
    return "local_tun_proxy" as const;
  const peers = remoteHosts.map(ipv4).filter((value) => value !== undefined);
  // mDNS/IPv6/absent candidates do not establish a subnet mismatch.
  if (!peers.length || peers.length !== remoteHosts.length || !locals.length) return;
  const ranges = locals.map((item) => ({ address: ipv4(item.address), mask: ipv4(item.netmask) }));
  if (ranges.some(({ address, mask }) => address === undefined || mask === undefined || mask === 0))
    return;
  if (
    peers.every((peer) =>
      ranges.every(
        ({ address, mask }) =>
          (peer & (mask as number)) !== ((address as number) & (mask as number)),
      ),
    )
  )
    return "different_subnet" as const;
}
