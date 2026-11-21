import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { commandEnvironment } from "../command/environment.ts";
import { executeHostedCommand } from "../command/foreground-host.ts";
import { ExecError, type ExecOptions } from "../core/types.ts";
import { createSandboxConfig } from "../sandbox/sandbox-config.ts";
import { sensitiveReadBoundary } from "../sandbox/sensitive-paths.ts";
import { engineCandidates, findEngine } from "./office-convert.ts";

const TIMEOUT_MS = 120_000;
/** Same ceiling as the in-process Office chain; a larger rendering is refused, never truncated. */
const MAX_INPUT_BYTES = 100 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

export type OfficeConvertSource = "docx" | "xlsx" | "pptx" | "doc" | "xls" | "ppt";
export type OfficeConvertTarget = "pdf" | "docx" | "xlsx" | "pptx";

export type OfficeLibreOfficeReason =
  | "libreoffice_missing"
  | "libreoffice_isolation_unavailable"
  | "libreoffice_unsupported_format"
  | "libreoffice_failed"
  | "libreoffice_timeout";

export type OfficeLibreOfficeResult =
  | { status: "converted"; bytes: Uint8Array }
  | { status: "unavailable"; reason: OfficeLibreOfficeReason };

const LEGACY_TARGETS: Partial<Record<OfficeConvertSource, OfficeConvertTarget>> = {
  doc: "docx",
  xls: "xlsx",
  ppt: "pptx",
};

/** A doc/xls/ppt input only converts to its own OOXML family; PDF stays available from all six. */
export function officeConvertTarget(source: OfficeConvertSource, target: OfficeConvertTarget) {
  if (target === "pdf") return true;
  return LEGACY_TARGETS[source] === target;
}

function quote(word: string) {
  return `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * Runs one fixed LibreOffice conversion: the model never supplies a program, argument list or path.
 * Each run gets its own throwaway profile so concurrent conversions cannot fight over a lock, and the
 * sandbox profile is narrowed to that one directory instead of the ordinary command roots.
 */
export async function convertOfficeDocument(
  options: ExecOptions & { dataDir: string },
  input: {
    bytes: Uint8Array;
    source: OfficeConvertSource;
    target: OfficeConvertTarget;
    signal: AbortSignal;
    /** Re-checks the user's approval immediately before the sandbox acknowledges dispatch. */
    assertCurrent(): void;
  },
): Promise<OfficeLibreOfficeResult> {
  if (!officeConvertTarget(input.source, input.target))
    return { status: "unavailable", reason: "libreoffice_unsupported_format" };
  if (!input.bytes.length || input.bytes.length > MAX_INPUT_BYTES)
    throw new ExecError("invalid_input");
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(TIMEOUT_MS)]);
  const engine = await findEngine(engineCandidates(options.platform, options.env), signal);
  if (!engine) return { status: "unavailable", reason: "libreoffice_missing" };
  // Windows has no command sandbox, and this recipe never falls back to an unisolated run.
  if (options.platform !== "darwin" && options.platform !== "linux")
    return { status: "unavailable", reason: "libreoffice_isolation_unavailable" };
  const work = await mkdtemp(join(options.tempDir, "office-convert-"));
  try {
    return await convertIn(options, input, work, engine, signal);
  } catch (error) {
    if (input.signal.aborted) throw new ExecError("command_failed", "cancelled");
    if (signal.aborted) return { status: "unavailable", reason: "libreoffice_timeout" };
    if (error instanceof ExecError) {
      if (["isolation_unavailable", "sandbox_unavailable"].includes(String(error.reason)))
        return { status: "unavailable", reason: "libreoffice_isolation_unavailable" };
      if (error.reason === "cancelled")
        return { status: "unavailable", reason: "libreoffice_timeout" };
    }
    return { status: "unavailable", reason: "libreoffice_failed" };
  } finally {
    // The directory only holds a copy of the user's file and one private profile; a failed cleanup
    // must not turn a finished conversion into an error, and the app temp sweep owns stragglers.
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

async function convertIn(
  options: ExecOptions & { dataDir: string },
  input: {
    bytes: Uint8Array;
    source: OfficeConvertSource;
    target: OfficeConvertTarget;
    signal: AbortSignal;
    assertCurrent(): void;
  },
  work: string,
  engine: string,
  signal: AbortSignal,
): Promise<OfficeLibreOfficeResult> {
  const inbound = join(work, "in");
  const outbound = join(work, "out");
  const profile = join(work, "profile");
  await Promise.all([inbound, outbound, profile].map((path) => mkdir(path, { mode: 0o700 })));
  const source = join(inbound, `input.${input.source}`);
  await writeFile(source, input.bytes, { mode: 0o600, flag: "wx" });
  const boundary = await sensitiveReadBoundary(
    options.platform,
    [options.systemHome, work],
    options.env,
    { botHome: work, dataDir: options.dataDir },
  );
  if (!boundary.permitsWriteRoot(work)) throw new ExecError("outside_workplace");
  const sandbox = createSandboxConfig(options);
  const config = await sandbox.config([work], { allowAll: false, domains: [] }, signal, {
    botHome: work,
    dataDir: options.dataDir,
  });
  // The fixed recipe has exactly one writable directory; ordinary command roots never apply.
  config.filesystem.allowWrite = [{ path: work, literal: true }];
  config.filesystem.gitManifestWriteRoots = [];
  config.filesystem.allowRead ??= [];
  config.filesystem.allowRead.push({ path: work, literal: true });
  const env = commandEnvironment(options.platform, options.env, work, work);
  const command = [
    engine,
    "--headless",
    "--norestore",
    "--nodefault",
    "--nolockcheck",
    `-env:UserInstallation=${pathToFileURL(profile).href}`,
    "--convert-to",
    input.target,
    "--outdir",
    outbound,
    source,
  ]
    .map(quote)
    .join(" ");
  const log = createWriteStream(join(work, "convert.log"), { flags: "wx", mode: 0o600 });
  try {
    // Open failures must surface before sandbox preparation starts hiding them.
    await once(log, "open");
    await executeHostedCommand({
      options,
      config,
      allowAll: false,
      command,
      commandText: "office_convert_libreoffice",
      commandId: randomUUID(),
      cwd: work,
      env,
      signal,
      log,
      dispatch: () => input.assertCurrent(),
      prepared: async () => {
        input.assertCurrent();
        signal.throwIfAborted();
        input.assertCurrent();
      },
    });
    signal.throwIfAborted();
  } finally {
    log.end();
  }
  const produced = join(outbound, `input.${input.target}`);
  const info = await stat(produced).catch(() => undefined);
  if (!info?.isFile() || !info.size || info.size > MAX_OUTPUT_BYTES)
    return { status: "unavailable", reason: "libreoffice_failed" };
  return { status: "converted", bytes: new Uint8Array(await readFile(produced)) };
}
