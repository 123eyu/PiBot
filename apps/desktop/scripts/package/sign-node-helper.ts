import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
export const NODE_HELPER_IDENTIFIER = "app.pibot.node-helper";

/**
 * Option a: the helper Node gets its own code identity (identifier, hardened runtime,
 * its own entitlements), so the keychain never treats it as Pi Bot even when one certificate signs
 * both. Signed after electron-builder's pass and before the bundle is sealed again.
 */
export async function signNodeHelper(app: string, identity: string, desktop: string) {
  const helper = join(app, "Contents", "Resources", "bin", "node");
  await run(
    "/usr/bin/codesign",
    [
      "--force",
      "--sign",
      identity,
      "--identifier",
      NODE_HELPER_IDENTIFIER,
      "--options",
      "runtime",
      "--entitlements",
      join(desktop, "build", "node-helper.entitlements.plist"),
      "--timestamp=none",
      helper,
    ],
    { timeout: 120_000, killSignal: "SIGKILL" },
  );
  return helper;
}

/** The helper is signed separately from Pi Bot: another identifier, no Pi Bot entitlements. */
export async function verifyNodeHelper(app: string, native: boolean) {
  const helper = join(app, "Contents", "Resources", "bin", "node");
  const { stderr } = await run("/usr/bin/codesign", ["-dvv", "--entitlements", ":-", helper], {
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
  assert.match(
    stderr,
    new RegExp(`^Identifier=${NODE_HELPER_IDENTIFIER.replaceAll(".", "\\.")}$`, "m"),
  );
  assert.match(
    stderr,
    /flags=0x[0-9a-f]+\(.*runtime.*\)/,
    "Node helper must use the hardened runtime",
  );
  const { stdout } = await run("/usr/bin/codesign", ["-d", "--entitlements", ":-", helper], {
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
  assert(
    !stdout.includes("keychain-access-groups"),
    "Node helper must not carry keychain access groups",
  );
  await run("/usr/bin/codesign", ["--verify", "--strict", helper], { timeout: 30_000 });
  // Cross builds already check the binary architecture and signature, but cannot run it here.
  if (!native) return null;
  // The first launch of a freshly signed binary waits on the system's code assessment, which took
  // over 30 s for this 113 MB binary on a loaded machine (2026-11-14); later launches are instant.
  const { stdout: version } = await run(helper, ["--version"], {
    encoding: "utf8",
    timeout: 180_000,
    killSignal: "SIGKILL",
  });
  return version.trim();
}
