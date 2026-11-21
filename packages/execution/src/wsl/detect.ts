import { execFile } from "node:child_process";
import { win32 } from "node:path";

export interface WslDistribution {
  name: string;
  version: 1 | 2;
  default: boolean;
}

export type WslDetection =
  | { available: true; distribution: string; distributions: WslDistribution[] }
  | {
      available: false;
      reason: "wsl_platform_unsupported" | "wsl_unavailable" | "wsl_no_default" | "wsl_default_v1";
    };

/** wsl.exe uses UTF-16LE on some supported Windows versions and UTF-8 on others. */
function decode(buffer: Buffer) {
  return buffer.toString(buffer.includes(0) ? "utf16le" : "utf8").replace(/^\uFEFF/, "");
}

/** Status/header labels are localized, so only names from --quiet and the numeric version count. */
export function parseWslDistributions(quiet: string, verbose: string): WslDistribution[] {
  const names = quiet
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean);
  if (
    names.length > 64 ||
    new Set(names).size !== names.length ||
    names.some((name) => name.length > 256 || /[\p{Cc}\p{Cf}]/u.test(name))
  )
    throw new Error("wsl_list_invalid");
  const rows: WslDistribution[] = [];
  for (const line of verbose.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const text = line.trimStart();
    const isDefault = text.startsWith("*");
    const content = (isDefault ? text.slice(1) : text).trimStart();
    // Longest first keeps "Ubuntu" from claiming "Ubuntu Test".
    const name = names
      .slice()
      .sort((a, b) => b.length - a.length)
      .find(
        (candidate) => content.startsWith(candidate) && /^\s/.test(content.slice(candidate.length)),
      );
    if (!name) continue;
    const match = /\s([12])\s*$/.exec(content.slice(name.length));
    if (!match || rows.some((row) => row.name === name)) throw new Error("wsl_list_invalid");
    rows.push({ name, version: match[1] === "2" ? 2 : 1, default: isDefault });
  }
  if (rows.length !== names.length || rows.filter((row) => row.default).length > 1)
    throw new Error("wsl_list_invalid");
  return rows;
}

function list(program: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    // A discovery timeout can kill the client: no user command has been dispatched here.
    let result: { error: boolean; stdout: Buffer } | undefined;
    const child = execFile(
      program,
      args,
      { encoding: "buffer", maxBuffer: 64 * 1024, timeout: 10_000, windowsHide: true, signal },
      (error, stdout) => {
        result = { error: !!error, stdout };
      },
    );
    // execFile can call back on AbortError before close; retain discovery ownership until exit.
    child.once("close", () => {
      if (!result || result.error) reject(new Error("wsl_unavailable"));
      else resolve(decode(result.stdout));
    });
  });
}

/** Discovery never installs WSL, starts a distro shell, or changes its default/configuration. */
export async function detectWsl(options: {
  platform: NodeJS.Platform;
  systemRoot?: string;
  signal: AbortSignal;
}): Promise<WslDetection> {
  options.signal.throwIfAborted();
  if (options.platform !== "win32") return { available: false, reason: "wsl_platform_unsupported" };
  if (
    !options.systemRoot ||
    !/^[a-z]:\\(?:[^\\]+\\)*Windows$/i.test(options.systemRoot) ||
    /[\p{Cc}\p{Cf}]/u.test(options.systemRoot)
  )
    return { available: false, reason: "wsl_unavailable" };
  const program = win32.join(options.systemRoot, "System32", "wsl.exe");
  try {
    const results = await Promise.allSettled([
      list(program, ["--list", "--quiet"], options.signal),
      list(program, ["--list", "--verbose"], options.signal),
    ]);
    options.signal.throwIfAborted();
    const [quiet, verbose] = results.map((result) => {
      if (result.status === "rejected") throw new Error("wsl_unavailable");
      return result.value;
    });
    if (quiet === undefined || verbose === undefined) throw new Error("wsl_unavailable");
    const distributions = parseWslDistributions(quiet, verbose);
    const current = distributions.find((item) => item.default);
    if (!current) return { available: false, reason: "wsl_no_default" };
    if (current.version !== 2) return { available: false, reason: "wsl_default_v1" };
    return { available: true, distribution: current.name, distributions };
  } catch {
    options.signal.throwIfAborted();
    return { available: false, reason: "wsl_unavailable" };
  }
}
