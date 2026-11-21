import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

/** Resolve from the deployed tree, so a host binary cannot silently satisfy another target. */
export async function inspectRunnerRtc(app: string, target: { platform: string; arch: string }) {
  const require = createRequire(join(app, "package.json"));
  const nativeRequire = createRequire(require.resolve("node-datachannel"));
  const suffix = target.platform === "linux" ? "-gnu" : target.platform === "win32" ? "-msvc" : "";
  const name = `@node-datachannel/${target.platform}-${target.arch}${suffix}`;
  let binary: string;
  try {
    binary = nativeRequire.resolve(name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
    return { status: "unsupported" as const, package: name, version: "0.33.6" };
  }
  const manifest = JSON.parse(
    await readFile(nativeRequire.resolve(`${name}/package.json`), "utf8"),
  );
  if (manifest.version !== "0.33.6") throw new Error("runner_rtc_prebuilt_version");
  const sha256 = await inspectNativeBinary(binary, target);
  return {
    status: "supported" as const,
    package: name,
    version: manifest.version as string,
    sha256,
  };
}

export async function inspectNativeBinary(
  binary: string,
  target: { platform: string; arch: string },
) {
  const bytes = await readFile(binary);
  let valid = false;
  if (bytes.length > 64) {
    if (target.platform === "linux")
      valid =
        bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) &&
        bytes[4] === 2 &&
        bytes[5] === 1 &&
        bytes.readUInt16LE(18) === (target.arch === "x64" ? 62 : 183);
    else if (target.platform === "darwin")
      valid =
        bytes.readUInt32LE(0) === 0xfeedfacf &&
        bytes.readUInt32LE(4) === (target.arch === "x64" ? 0x1000007 : 0x100000c);
    else {
      const offset = bytes.readUInt32LE(60);
      valid =
        bytes.readUInt16LE(0) === 0x5a4d &&
        offset + 6 <= bytes.length &&
        bytes.readUInt32LE(offset) === 0x4550 &&
        bytes.readUInt16LE(offset + 4) === (target.arch === "x64" ? 0x8664 : 0xaa64);
    }
  }
  if (!valid) throw new Error("runner_native_prebuilt_architecture");
  return createHash("sha256").update(bytes).digest("hex");
}
