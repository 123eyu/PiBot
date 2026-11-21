import type { GitResourceSnapshot } from "@pibot/execution";
import { type GitResourceFacts, GitResourceFactsSchema } from "@pibot/protocol-base";

/** The execution boundary owns discovery; this adapter cannot infer an approval from its facts. */
export function toPolicyGitResourceFacts(snapshot: GitResourceSnapshot): GitResourceFacts {
  return GitResourceFactsSchema.parse(snapshot);
}
