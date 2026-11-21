// The commonest silent block is not a denial at all. Inside the sandbox HOME is the
// Bot's own folder, so `aws`, `gh`, `kubectl` look for ~/.aws, ~/.config/gh, ~/.kube there, find
// nothing, and report "unable to locate credentials" / "not logged in" — nothing was refused, so
// neither Seatbelt nor bubblewrap reports anything. The block is named only when brain's shell
// analysis proves ownsStatus (one invocation, no negation or file redirects), the user does have
// that store in their real home, the Bot home has none, and the run
// failed or printed a missing-login message. `printf 'aws'` or `aws --version && false` never is.
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { SandboxBlockItem } from "../core/types.ts";

/** Program → where it keeps the user's login/config, relative to HOME. Fixed data, not patterns. */
const TOOLS: Record<string, readonly string[]> = {
  aws: [".aws"],
  gh: [".config/gh"],
  gcloud: [".config/gcloud"],
  gsutil: [".config/gcloud"],
  bq: [".config/gcloud"],
  kubectl: [".kube"],
  helm: [".kube"],
  k9s: [".kube"],
  az: [".azure"],
  ssh: [".ssh"],
  scp: [".ssh"],
  sftp: [".ssh"],
  terraform: [".terraform.d"],
  vault: [".vault-token"],
  op: [".config/op"],
  docker: [".docker/config.json"],
};
async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch {
    // Missing or unreadable to the app itself: either way not a store the tool could have used.
    return false;
  }
}

export async function credentialToolItems(input: {
  /** Brain's AST-confirmed sole program of the line; nothing is guessed from the text here. */
  program: string | undefined;
  userHome: string;
  botHome: string;
}): Promise<SandboxBlockItem[]> {
  const items: SandboxBlockItem[] = [];
  for (const store of (input.program && Object.hasOwn(TOOLS, input.program)
    ? TOOLS[input.program]
    : undefined) ?? []) {
    const parts = store.split("/");
    // The Bot keeping its own store (a login made inside the sandbox) is not this block.
    if (await exists(join(input.botHome, ...parts))) continue;
    if (await exists(join(input.userHome, ...parts)))
      items.push({ kind: "credential_read", rule: "bot_home", target: `~/${store}` });
  }
  return items;
}
