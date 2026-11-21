import type { CapabilityMapping } from "./types.ts";

export const webSearchMapping: CapabilityMapping = {
  capabilityId: "web.search",
  match: () => false,
  tools: {},
  readOnlyTools: new Set(),
};
