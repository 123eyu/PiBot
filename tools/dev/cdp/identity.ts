import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

export interface CdpIdentity {
  pid: number;
  port: number;
  executable: string;
  dataDir: string;
  runId: string;
  artifactDigest: string;
}

/** This developer-only file is not a renderer capability or a general CDP target selector. */
export function parseCdpIdentity(value: unknown): CdpIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join(",") !== "artifactDigest,dataDir,executable,pid,port,runId" ||
    !Number.isSafeInteger(v.pid) ||
    Number(v.pid) <= 0 ||
    !Number.isInteger(v.port) ||
    Number(v.port) < 1024 ||
    Number(v.port) > 65535 ||
    typeof v.runId !== "string" ||
    !/^[a-f0-9-]{36}$/.test(v.runId) ||
    typeof v.artifactDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(v.artifactDigest)
  )
    throw invalid();
  for (const key of ["executable", "dataDir"] as const)
    if (
      typeof v[key] !== "string" ||
      !isAbsolute(v[key]) ||
      v[key].length > 32768 ||
      /[\0\r\n]/.test(v[key])
    )
      throw invalid();
  return v as unknown as CdpIdentity;
}
export function assertCdpProcess(identity: CdpIdentity, command: unknown, processes: unknown) {
  const args = (command as { arguments?: unknown })?.arguments;
  const rows = (processes as { processInfo?: unknown })?.processInfo;
  if (
    !Array.isArray(args) ||
    args.length > 512 ||
    args.some((x) => typeof x !== "string" || x.length > 32768) ||
    args[0] !== identity.executable ||
    !Array.isArray(rows) ||
    rows.length > 1024 ||
    rows.filter((row) => row?.type === "browser" && row?.id === identity.pid).length !== 1
  )
    throw invalid();
  for (const expected of [
    `--pibot-test-run=${identity.runId}`,
    `--remote-debugging-port=${identity.port}`,
    `--user-data-dir=${join(identity.dataDir, "gui-instance")}`,
  ]) {
    const name = expected.split("=")[0] as string;
    const values = args.filter((arg) => arg === name || arg.startsWith(`${name}=`));
    if (!values.length || values.some((arg) => arg !== expected)) throw invalid();
  }
  if (!args.includes("--enable-automation")) throw invalid();
}
export function ownedRenderer(url: string, identity: CdpIdentity) {
  try {
    const actual = new URL(url);
    actual.search = "";
    actual.hash = "";
    const bundle = identity.executable.slice(0, -"/Contents/MacOS/Pi Bot".length);
    return (
      actual.href ===
      pathToFileURL(
        join(bundle, "Contents", "Resources", "app.asar", "out", "renderer", "index.html"),
      ).href
    );
  } catch {
    return false;
  }
}
function invalid() {
  return new Error("cdp_identity_mismatch");
}
