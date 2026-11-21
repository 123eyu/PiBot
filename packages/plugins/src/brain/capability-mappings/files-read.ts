import { filesystemFingerprint } from "./fingerprints.ts";
import type { CapabilityMapping } from "./types.ts";

export const filesReadMapping: CapabilityMapping = {
  capabilityId: "files.read",
  match: filesystemFingerprint,
  tools: {
    read_file: "read_file",
    read_text_file: "read_file",
    list_directory: "list_dir",
    search_files: "find_files",
  },
  readOnlyTools: new Set(["read_file", "read_text_file", "list_directory", "search_files"]),
};
