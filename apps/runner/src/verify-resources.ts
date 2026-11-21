import { verifyResourceManifest } from "@pibot/execution/resource-manifest";

declare const __PIBOT_RUNNER_RESOURCES_SHA256__: string;

export function verifyResources(root: string) {
  return verifyResourceManifest(root, __PIBOT_RUNNER_RESOURCES_SHA256__);
}
