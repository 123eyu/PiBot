import { isAbsolute } from "node:path";
import { packageCommand } from "./command.ts";
import type { Target } from "./types.ts";

/** Signing follows injection; development outputs stay explicitly unsigned without release credentials. */
export async function signRunner(executable: string, target: Target, bundle?: string) {
  if (target.platform === "darwin") {
    if (process.platform !== "darwin") throw new Error("runner_macos_signing_requires_macos");
    const identity = process.env.PIBOT_RUNNER_CODESIGN_IDENTITY ?? "-";
    await packageCommand("/usr/bin/codesign", ["--force", "--sign", identity, executable]);
    await packageCommand("/usr/bin/codesign", ["--verify", "--strict", executable]);
    // The .app is sealed after its executable: the bundle signature covers Resources and Info.plist.
    if (bundle) {
      await packageCommand("/usr/bin/codesign", ["--force", "--sign", identity, bundle]);
      await packageCommand("/usr/bin/codesign", ["--verify", "--strict", bundle]);
    }
    return identity === "-" ? "adhoc" : "codesign";
  }
  if (target.platform === "win32") {
    const tool = process.env.PIBOT_RUNNER_SIGNTOOL;
    const certificate = process.env.PIBOT_RUNNER_CERT_SHA1;
    if (tool || certificate) {
      if (!tool || !isAbsolute(tool) || !certificate || !/^[a-f0-9]{40}$/i.test(certificate))
        throw new Error("runner_signing_configuration");
      await packageCommand(tool, ["sign", "/sha1", certificate, "/fd", "SHA256", executable]);
      await packageCommand(tool, ["verify", "/pa", executable]);
      return "authenticode";
    }
    if (process.env.PIBOT_RUNNER_REQUIRE_SIGNING === "1")
      throw new Error("runner_signing_required");
  }
  return "unsigned";
}
