import { filesystemFingerprint } from "./fingerprints.ts";
import type { CapabilityMapping } from "./types.ts";

export const filesWriteMapping: CapabilityMapping = {
  capabilityId: "files.write",
  match: filesystemFingerprint,
  tools: {
    write_file: "write_file",
    edit_file: "edit_file",
  },
  readOnlyTools: new Set(),
};
