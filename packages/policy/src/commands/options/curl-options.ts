import type { ArgumentFacts } from "../argument-types.ts";

/**
 * A plain curl GET/HEAD is a download like web_fetch, so it is judged
 * by the network rules (allowed domains, the web level) instead of always asking. Only the
 * options below are understood; anything else (an output file, an upload, a body, a form, a
 * config or cookie file, credentials, a proxy or socket, another method) leaves curl a mutator
 * that asks every time, as before.
 *
 * `-L` is accepted: a redirect may lead to another host, but the sandbox proxy only lets the
 * command reach the hosts its network list allows (an automatic run gets the bounded list), so a
 * redirect cannot widen where it goes. Residual: curl also reads its own config file (`.curlrc`
 * in the command HOME) unless `-q` comes first; the sandbox still bounds what that file can make
 * curl write or reach.
 */
const FLAGS = new Map<string, string>([
  ["-s", "-s"],
  ["--silent", "-s"],
  ["-S", "-S"],
  ["--show-error", "-S"],
  ["-f", "-f"],
  ["--fail", "-f"],
  ["--fail-with-body", "--fail-with-body"],
  ["-L", "-L"],
  ["--location", "-L"],
  ["-I", "-I"],
  ["--head", "-I"],
  ["-i", "-i"],
  ["--include", "-i"],
  ["-v", "-v"],
  ["--verbose", "-v"],
  ["-g", "-g"],
  ["--globoff", "-g"],
  ["-N", "-N"],
  ["--no-buffer", "-N"],
  ["-#", "-#"],
  ["--progress-bar", "-#"],
  ["--no-progress-meter", "--no-progress-meter"],
  ["--compressed", "--compressed"],
  ["-4", "-4"],
  ["--ipv4", "-4"],
  ["-6", "-6"],
  ["--ipv6", "-6"],
  ["--http1.1", "--http1.1"],
  ["--http2", "--http2"],
  ["-q", "-q"],
  ["--disable", "-q"],
]);
const VALUES = new Map<string, string>([
  ["-H", "-H"],
  ["--header", "-H"],
  ["-A", "-A"],
  ["--user-agent", "-A"],
  ["-e", "-e"],
  ["--referer", "-e"],
  ["-m", "-m"],
  ["--max-time", "-m"],
  ["--connect-timeout", "-m"],
  ["--retry", "-m"],
  ["--retry-delay", "-m"],
  ["--retry-max-time", "-m"],
  ["--max-redirs", "-m"],
  ["-r", "-r"],
  ["--range", "-r"],
  ["-w", "-w"],
  ["--write-out", "-w"],
  ["-X", "-X"],
  ["--request", "-X"],
  ["--url", "--url"],
]);

/** The facts of a read-only curl, or undefined when the call is anything else. */
export function readonlyCurl(args: readonly string[]): ArgumentFacts | undefined {
  const facts: ArgumentFacts = {
    reads: [],
    writes: [],
    readonly: true,
    incomplete: false,
    unknownOptions: [],
    network: true,
    domains: [],
  };
  const urls: string[] = [];
  const value = (option: string, text: string): boolean => {
    if (option === "--url") return !!urls.push(text);
    if (option === "-X") return text === "GET" || text === "HEAD";
    if (option === "-m") return /^\d+(?:\.\d+)?$/u.test(text);
    if (option === "-r") return /^[\d,-]+$/u.test(text);
    // `-H @-` reads headers from stdin; `-H @file` / `-w @file` read that file.
    if ((option === "-H" || option === "-w") && text.startsWith("@")) {
      if (text !== "@-") facts.reads.push(text.slice(1));
      return text.length > 1;
    }
    // `%output{file}` makes --write-out write a file.
    if (option === "-w") return !/%output\{/iu.test(text);
    return true;
  };
  let operands = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (operands || !arg.startsWith("-") || arg === "-") {
      urls.push(arg);
      continue;
    }
    if (arg === "--") {
      operands = true;
      continue;
    }
    if (arg.startsWith("--")) {
      // curl takes long option values as the next word; `--opt=value` is not a curl form.
      if (FLAGS.has(arg)) continue;
      const option = VALUES.get(arg);
      const next = args[i + 1];
      if (!option || next === undefined || !value(option, next)) return undefined;
      i++;
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const short = `-${arg[j]}`;
      if (FLAGS.has(short)) continue;
      const option = VALUES.get(short);
      if (!option) return undefined;
      const attached = arg.slice(j + 1);
      const text = attached || args[++i];
      if (text === undefined || !value(option, text)) return undefined;
      break;
    }
  }
  if (!urls.length) return undefined;
  for (const url of urls) {
    // An explicit http(s) scheme: a bare host lets curl guess ftp, and file:// reads locally.
    // Globs (`{a,b}`, `[1-9]`) could name other hosts; credentials in the URL are a send.
    if (!/^https?:\/\/[^\s{}[\]\\]+$/iu.test(url)) return undefined;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return undefined;
    }
    if (!parsed.hostname || parsed.username || parsed.password) return undefined;
    facts.domains.push(parsed.hostname.toLowerCase());
  }
  return facts;
}

/** `-L` lets the response choose the next host; only the sandbox proxy then bounds it. */
export function curlFollowsRedirects(args: readonly string[]) {
  return args.some((arg) => arg === "--location" || /^-[^-]*L/u.test(arg));
}
