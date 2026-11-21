import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { runInstallCommand } from "./app-install-process.ts";

// ASAR parsing is synchronous. Keep it in a bounded child for the cancellable install path.
const extraction = `
const {createHash}=require('node:crypto');
const asar=require(process.argv[1]);
const archive=process.argv[2], version=process.argv[3];
for(const [name,limit] of [['package.json',65536],['out/main/startup-bundle.sha256',256]]) {
  const stat=asar.statFile(archive,name);
  if(stat.unpacked || stat.link || !Number.isSafeInteger(stat.size) || stat.size<1 || stat.size>limit)
    throw new Error('mac_artifact_runtime_invalid');
}
const pkg=JSON.parse(asar.extractFile(archive,'package.json').toString('utf8'));
const bundle=asar.extractFile(archive,'out/main/startup-bundle.sha256').toString('utf8').trim();
if(pkg.version!==version || !/^[a-f0-9]{64}$/.test(bundle)) throw new Error('mac_artifact_runtime_invalid');
process.stdout.write(version+':'+createHash('sha256').update(version).update(bundle).digest('hex'));
`;

function args(archive: string, version: string) {
  const desktop = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
  const builder = createRequire(desktop.resolve("electron-builder/package.json"));
  const lib = createRequire(builder.resolve("app-builder-lib/package.json"));
  return [
    "--input-type=commonjs",
    "-e",
    extraction,
    lib.resolve("@electron/asar"),
    archive,
    version,
  ];
}
function checked(value: string, version: string) {
  if (!value.startsWith(`${version}:`) || !/^[a-f0-9]{64}$/.test(value.slice(version.length + 1)))
    throw new Error("mac_artifact_runtime_invalid");
  return value;
}

export function artifactRuntimeVersion(archive: string, version: string) {
  return checked(
    execFileSync(process.execPath, args(archive, version), {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 4096,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim(),
    version,
  );
}

export async function artifactRuntimeVersionAsync(
  archive: string,
  version: string,
  signal: AbortSignal,
) {
  return checked(
    await runInstallCommand(process.execPath, args(archive, version), signal),
    version,
  );
}
