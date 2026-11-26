import type { TranslationKey } from "@pibot/i18n";
import { type MethodParams, type MethodResults, RpcError, RpcErrorCodes } from "@pibot/protocol";

export const sources = ["chatgpt", "claude", "claude-code", "codex", "cursor", "gemini"] as const;
export type Source = (typeof sources)[number];
export const marks: Record<Source, string> = {
  chatgpt: "C",
  claude: "A",
  "claude-code": "CC",
  codex: "Cx",
  cursor: "Cu",
  gemini: "G",
};
export const localSources = new Set<Source>(["claude-code", "codex", "cursor"]);

export type Preview = NonNullable<MethodResults["import.preview"]>;
export type Status = MethodResults["import.status"];
export type Project = NonNullable<MethodResults["import.reviewProject"]>;
export type Quote = NonNullable<MethodResults["import.estimateDistillation"]>;
export type Scope = MethodParams["import.reviewMemories"]["scope"];
export type Review = MethodResults["import.reviewMemories"];
export type Selection = { review: Review; selected: string[] };

export const reviewOptions = { timeoutMs: 95_000 };
export const backgroundOptions = { timeoutMs: 115_000 };

export function selection(review: Review, scope: Scope): Selection {
  return {
    review,
    // Replacing a persona and keeping a conflict both require selecting individual content.
    selected:
      scope === "persona"
        ? []
        : review.items.filter(({ outcome }) => outcome === "add").map(({ id }) => id),
  };
}

function choice(value?: Selection) {
  return value?.selected.length
    ? { reviewId: value.review.reviewId, selected: value.selected }
    : undefined;
}

export function startParams({
  preview,
  botId,
  conversations,
  memories,
  persona,
  project,
  quote,
}: {
  preview: Preview;
  botId: string;
  conversations: boolean;
  memories?: Selection;
  persona?: Selection;
  project?: Project;
  quote?: Quote;
}): MethodParams["import.start"] | undefined {
  const memoryReview = choice(memories);
  const personaReview = choice(persona);
  if (!botId || (!conversations && !memoryReview && !personaReview && !project)) return;
  return {
    importId: preview.importId,
    botId,
    conversations,
    ...(memoryReview && { memoryReview }),
    ...(personaReview && { personaReview }),
    ...(project && { projectReviewId: project.reviewId }),
    ...(conversations && quote && { distillationQuoteId: quote.quoteId }),
  };
}

const stage: Record<Status["state"], number> = {
  running: 0,
  completed: 1,
  undoing: 2,
  cancelled: 3,
  failed: 3,
  undone: 3,
};

export function advanceStatus(current: Status, next: Status): Status {
  if (current.importId !== next.importId || stage[next.state] < stage[current.state])
    return current;
  // A late page-write event must not hide the compensation phase of the same running batch.
  if (current.cleanup && !next.cleanup && next.state === "running") return current;
  if (next.state === "running" && !next.cleanup) {
    return {
      ...next,
      topics: Math.max(current.topics, next.topics),
      messages: Math.max(current.messages, next.messages),
    };
  }
  if (next.cleanup || next.state === "undoing") {
    return {
      ...next,
      removed: {
        topics: Math.max(current.removed?.topics ?? 0, next.removed?.topics ?? 0),
        messages: Math.max(current.removed?.messages ?? 0, next.removed?.messages ?? 0),
      },
    };
  }
  return next;
}

export function startError(
  error: unknown,
): Extract<TranslationKey, `conversationImport.error.${string}`> {
  if (error instanceof RpcError && error.code === RpcErrorCodes.timeout)
    return "conversationImport.error.timeout";
  const code = error instanceof RpcError ? error.message : "";
  switch (code) {
    case "import_source_unsupported":
    case "import_desktop_only":
    case "import_memory_source_unsupported":
      return "conversationImport.error.unsupported";
    case "import_preview_busy":
    case "import_busy":
      return "conversationImport.error.busy";
    case "import_preview_timeout":
      return "conversationImport.error.timeout";
    case "import_preview_expired":
    case "import_memory_review_expired":
    case "import_project_review_expired":
    case "import_distillation_quote_expired":
      return "conversationImport.error.expired";
    case "import_format_chatgpt":
    case "import_format_claude":
    case "import_format_claude_code":
    case "import_format_codex":
    case "import_format_cursor":
    case "import_format_gemini":
      return "conversationImport.error.format";
    case "import_source_changed":
      return "conversationImport.error.source_changed";
    case "import_limit":
      return "conversationImport.error.limit";
    case "import_target":
      return "conversationImport.error.target";
    case "import_project_unavailable":
      return "conversationImport.error.project";
    case "import_persona_unavailable":
    case "import_persona_limit":
    case "import_memory_selection_invalid":
      return "conversationImport.error.selection";
    default:
      return "conversationImport.error.internal";
  }
}
