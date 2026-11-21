import { fetchFingerprint } from "./fingerprints.ts";
import type { CapabilityMapping } from "./types.ts";

export const webFetchMapping: CapabilityMapping = {
  capabilityId: "web.fetch",
  match: fetchFingerprint,
  tools: { fetch: "web_fetch" },
  readOnlyTools: new Set(["fetch"]),
};
