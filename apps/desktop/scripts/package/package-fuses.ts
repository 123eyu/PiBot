import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FuseV1Options, FuseVersion, flipFuses, getCurrentFuseWire } from "@electron/fuses";
import type { PackageMode } from "./package-options.ts";

export function packagedElectron(directory: string, platform: string) {
  if (platform === "linux" && existsSync(join(directory, "pi-bot-bin")))
    return join(directory, "pi-bot-bin");
  return join(
    directory,
    platform === "darwin" ? "Pi Bot.app" : platform === "win32" ? "Pi Bot.exe" : "pi-bot",
  );
}

export function packageFuseSettings(mode: PackageMode) {
  const release = mode === "release";
  return {
    version: FuseVersion.V1,
    // Option a (maintainers 2026-11-14): nothing may run code as Pi Bot. Child Node workloads
    // use the separately signed helper (resources/bin/node), so Pi Bot's own executable cannot be
    // started as Node (RunAsNode), handed code through NODE_OPTIONS, or attached to with
    // --inspect, in test builds as much as in releases (test builds are installed and used).
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: release,
    [FuseV1Options.OnlyLoadAppFromAsar]: release,
  };
}

/** Called before signing, for every mode: the identity fuses above apply to test builds too. */
export async function configurePackageFuses(application: string, mode: PackageMode) {
  await flipFuses(application, packageFuseSettings(mode));
}

export async function verifyPackageFuses(application: string, mode: PackageMode) {
  const wire = await getCurrentFuseWire(application);
  assert.equal(wire.version, FuseVersion.V1, "Unsupported Electron fuse wire");
  const expected = packageFuseSettings(mode);
  for (const [key, value] of Object.entries(expected)) {
    if (key === "version") continue;
    const index = Number(key) as FuseV1Options;
    // The fuse wire stores enabled/disabled as ASCII '1'/'0'; removed fuses must fail too.
    assert.equal(
      wire[index],
      value ? 0x31 : 0x30,
      `Unexpected ${mode} fuse ${FuseV1Options[index]}`,
    );
  }
  console.info(
    JSON.stringify({
      event: "package.fuses.read",
      mode,
      application,
      // Electron currently implements runtime ASAR integrity only on macOS and Windows.
      asarIntegritySupported: application.endsWith(".app") || application.endsWith(".exe"),
      fuses: Object.fromEntries(
        Object.entries(wire).map(([key, value]) => [
          key === "version" ? key : (FuseV1Options[Number(key)] ?? key),
          key === "version"
            ? value
            : value === 0x31
              ? "Enabled"
              : value === 0x30
                ? "Disabled"
                : "Removed/unknown",
        ]),
      ),
    }),
  );
}
