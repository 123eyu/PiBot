function allowedV4(octets: number[]) {
  const [a, b] = octets;
  return (
    a !== 0 &&
    a !== 127 &&
    !(a === 169 && b === 254) &&
    a !== undefined &&
    a < 224 &&
    octets[3] !== 255
  );
}

/** Route hints cannot redirect a paired connection to local services or discovery endpoints. */
export function parseRunnerAddress(value: string) {
  const match = /^(?:\[([^\]%]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(value);
  const host = match?.[1] ?? match?.[2] ?? "";
  const family = host.includes(":") ? 6 : 4;
  const port = Number(match?.[3]);
  if (!match || (family === 6) !== !!match[1] || port < 1 || port > 65535)
    throw new TypeError("invalid_runner_address");
  let allowed: boolean;
  if (family === 4) {
    const parts = host.split(".");
    if (
      parts.length !== 4 ||
      parts.some((part) => !/^(?:0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)
    )
      throw new TypeError("invalid_runner_address");
    allowed = allowedV4(parts.map(Number));
  } else {
    // Bracketed URL hosts validate IPv6 syntax without DNS or a Node-only runtime dependency.
    let canonical: string;
    try {
      canonical = new URL(`http://[${host}]`).hostname.slice(1, -1);
    } catch {
      throw new TypeError("invalid_runner_address");
    }
    const halves = canonical.split("::");
    const left = halves[0] ? halves[0].split(":").map((part) => Number.parseInt(part, 16)) : [];
    const right = halves[1] ? halves[1].split(":").map((part) => Number.parseInt(part, 16)) : [];
    const words =
      halves.length === 2
        ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right]
        : left;
    const prefixZero = words.slice(0, 5).every((word) => word === 0);
    if (prefixZero && words[5] === 0xffff) {
      const high = words[6] as number;
      const low = words[7] as number;
      allowed = allowedV4([high >>> 8, high & 255, low >>> 8, low & 255]);
    } else {
      const first = words[0] as number;
      // Reject IPv4-compatible encodings too, including expanded unspecified and loopback.
      allowed =
        !(prefixZero && words[5] === 0) &&
        (first & 0xff00) !== 0xff00 &&
        (first & 0xffc0) !== 0xfe80;
    }
  }
  if (!allowed) throw new TypeError("invalid_runner_address");
  return { host, port, address: `${family === 6 ? `[${host}]` : host}:${port}` };
}
