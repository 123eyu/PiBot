export type {
  DirectoryIdentity,
  SearchFileContext,
  SearchTruncation,
} from "../files/search-walk.ts";
/** Brain indexes other languages too, but must keep this walk's exclusions and checks. */
export { checkedDirectory, skippableError, walkFiles } from "../files/search-walk.ts";
export { configDependencies } from "./config-chain.ts";
export { SemanticError, type SemanticFailure } from "./errors.ts";
export {
  captureProject,
  MAX_SOURCE_BYTES,
  readSource,
  type SourceRefusal,
  semanticHash,
  snapshotHash,
  verifySnapshotRoot,
} from "./loader.ts";
export { createSemanticService } from "./service.ts";
export type {
  SemanticFile,
  SemanticFileCache,
  SemanticFileCacheEntry,
  SemanticQuery,
  SemanticSnapshot,
  SourceAccess,
} from "./types.ts";
