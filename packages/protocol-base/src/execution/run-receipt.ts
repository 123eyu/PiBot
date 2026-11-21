import { z } from "zod";
import { MemoryScopeSchema } from "../bots/memory.ts";
import { IdSchema } from "../core/ids.ts";
import { PlanRelaxationHistorySchema } from "../groups/plan-relaxation.ts";
import { ReportVerdictSchema } from "../skills/verdict.ts";
import { BUDGET_RAISES_MAX } from "./tasks.ts";
import { CodeAnalysisSchema } from "./tool-calls.ts";

/**
 * Work receipt: what one finished run did, rebuilt only from records the app wrote itself
 * (audit log, the run's file changes, approvals, budget ledger, plan, delivery evidence, child
 * tasks). Never the model's own account of its work, and never message text, file contents,
 * prompts or secrets: only categories, counts, folders, domains, app names and short labels.
 */
const count = z.number().int().nonnegative().safe();
const key = z.string().min(1).max(300);
/** Top keys by count; `others` is how many further keys were folded away. */
export const ReceiptBucketsSchema = z.strictObject({
  total: count,
  items: z.array(z.strictObject({ key, count })).max(8),
  others: count,
});
export const RECEIPT_BUCKETS = 8;
export const RECEIPT_FILES = 10;
export const RECEIPT_UNVERIFIED = 10;
export const RECEIPT_DELIVERY_ITEMS = 20;
export const RECEIPT_UNCERTAIN = 10;
export const RECEIPT_CHILD_MODELS = 4;
/** Frozen by the orchestrator, never inferred from the assistant's account of its work. */
export const GroupExecutionReceiptSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("plan"),
    steps: count,
    coordinatorWorked: z.boolean().optional(),
    inProgress: z.boolean().optional(),
    acceptanceRelaxed: z.boolean().optional(),
    relaxations: PlanRelaxationHistorySchema.optional(),
  }),
  z.strictObject({ kind: z.literal("solo"), completed: z.boolean().optional() }),
]);
export type GroupExecutionReceipt = z.infer<typeof GroupExecutionReceiptSchema>;
/**
 * One call of this run whose outcome is unknown (a restart, a stop or a timeout cut it
 * off), from the execution journal. Tool name, effect class and when it started; never arguments
 * or results. The receipt's "needs checking" section lists these.
 */
export const ReceiptUncertainCallSchema = z.strictObject({
  tool: z.string().min(1).max(80),
  effectClass: z.enum(["idempotent", "local_effect", "external"]),
  createdAt: z.iso.datetime(),
});
export const CitationSectionNameSchema = z.enum([
  "来源",
  // The built-in fact-check contract names its bibliography 来源链 / Source chain.
  "来源链",
  "参考来源",
  "参考文献",
  "引用文献",
  "参考资料",
  "引用",
  "出处",
  "source",
  "sources",
  "sourcechain",
  "reference",
  "references",
  "bibliography",
]);

/**
 * Delivery check of a workflow run: each acceptance item of the skill's contract, judged by
 * the program after the run (no model). Section names and citation labels only in receipts; handoffs may carry bounded redacted verdict findings.
 * Stored on the run's reply (`usage.delivery`) and copied into the receipt.
 */
export const DeliveryItemSchema = z.strictObject({
  id: z.string().min(1).max(40),
  check: z.enum([
    "exists",
    "sections",
    "citations",
    "manual",
    "minCitations",
    "sectionsSourced",
    "tableColumns",
    "hasChart",
    "fileNaming",
    "gbt7714",
    "verdict",
  ]),
  /** Deliverable path relative to the artifact folder; null for a manual item without one. */
  deliverable: z.string().min(1).max(300).nullable(),
  /** The contract's own wording of the item (manual items are shown with it). */
  text: z.string().max(300).nullable(),
  status: z.enum(["pass", "fail", "manual"]),
  verdict: ReportVerdictSchema.optional(),
  reason: z
    .enum([
      "missing_file",
      "wrong_location",
      "empty_file",
      "missing_sections",
      "no_sources",
      "unresolved_citations",
      "too_few_citations",
      "section_unsourced",
      "missing_columns",
      "no_chart",
      "unreadable",
      "needs_human",
      "invalid_output_name",
      "invalid_citation_format",
      "verdict_missing",
    ])
    .nullable(),
  /** Missing section names or unresolved citation labels like "[3]". */
  missing: z.array(z.string().min(1).max(200)).max(10),
  /** Fixed diagnostics only; never source text, URLs or file contents. */
  referenceIssues: z
    .array(
      z.strictObject({
        label: z.string().regex(/^(?:\[\d{1,4}\]|unresolved_link)$/),
        reason: z.enum(["missing_file", "not_read", "invalid_format"]),
      }),
    )
    .max(10)
    .optional(),
  /** Parser facts only; resolution aliases are never source grants or raw paths. */
  citationContext: z
    .strictObject({
      section: z
        .union([CitationSectionNameSchema, z.literal("contract"), z.literal("subheading")])
        .nullable(),
      line: z.number().int().positive().optional(),
      bases: z.array(z.enum(["document", "artifact", "workspace"])).max(3),
    })
    .optional(),
  /** Paths only, no content. A misplaced file is still a failed delivery. */
  location: z
    .strictObject({
      expected: z.string().min(1).max(4096),
      actual: z.string().min(1).max(4096),
    })
    .optional(),
});
export const ReceiptDeliverySchema = z.strictObject({
  /** Workflow (skill display name) and its `pibot-version`. */
  workflow: z.string().min(1).max(80),
  version: z.number().int().positive().nullable(),
  /** `failed` = 交付未通过 after the allowed fix rounds; `manual` = only human items remain. */
  status: z.enum(["passed", "failed", "manual"]),
  fixRounds: z.number().int().min(0).max(5),
  maxFixRounds: z.number().int().min(0).max(5),
  /** Time the last check took (local file reads only). */
  durationMs: z.number().int().nonnegative().safe(),
  folder: z.string().min(1).max(1024).nullable(),
  items: z.array(DeliveryItemSchema).max(RECEIPT_DELIVERY_ITEMS),
});
export const RunReceiptSchema = z.strictObject({
  version: z.literal(1),
  runId: IdSchema,
  /** The run's own reply: a run with several messages shows its receipt under this one only. */
  messageId: IdSchema,
  botId: IdSchema,
  conversationId: IdSchema,
  groupId: IdSchema.nullable(),
  groupExecution: GroupExecutionReceiptSchema.optional(),
  codeAnalysis: CodeAnalysisSchema.optional(),
  source: z.enum(["chat", "group_task", "routine", "subtask", "wake"]),
  trigger: z.literal("background_finished").optional(),
  backgroundCommandId: IdSchema.optional(),
  outcome: z.enum(["done", "failed", "stopped", "running"]),
  /** Error code or stop reason from the run record (e.g. budget_exhausted, output_limit). */
  reasonCode: z.string().max(100).nullable(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  inputs: z.strictObject({
    /** Files read, by folder. */
    files: ReceiptBucketsSchema,
    /** Web pages fetched, by domain. */
    web: ReceiptBucketsSchema,
    /** Web searches, by search service. */
    searches: ReceiptBucketsSchema,
    /** Read-only connector calls, by app. */
    connectors: ReceiptBucketsSchema,
    /** Items read from the paired phone, by category. */
    phone: ReceiptBucketsSchema,
    /** Messages read from other conversations. */
    messages: count,
    /** Bot browser steps (open, click, read a page). */
    browser: count,
  }),
  outputs: z.strictObject({
    files: z
      .array(
        z.strictObject({
          path: z.string().min(1).max(1024),
          kind: z.enum(["add", "modify", "delete", "command"]),
          added: count.nullable(),
          removed: count.nullable(),
        }),
      )
      .max(RECEIPT_FILES),
    filesTotal: count,
    added: count,
    removed: count,
    /** Files sent into the conversation. */
    attachments: count,
    /** Images generated. */
    images: count,
  }),
  approvals: z.strictObject({
    asked: count,
    allowed: count,
    denied: count,
    /** Expired, cancelled or refused without an answer. */
    unanswered: count,
    /** Steps the conversation's YOLO switch allowed without a card. */
    automatic: count,
  }),
  actions: z.strictObject({
    commands: count,
    failedCommands: count,
    /** Connector drafts actually sent out. */
    sentDrafts: count,
    /** Tasks handed to other Bots in a group. */
    delegated: count,
    blocked: count,
  }),
  /** Null when this run has no budget ledger (older runs, or no local tools). */
  cost: z
    .strictObject({
      /** True when the ledger also covers continuations or child tasks of the same work. */
      shared: z.boolean(),
      requests: count,
      tokens: count,
      /** Known cost; null when no request had pricing. */
      costUsd: z.number().nonnegative().finite().nullable(),
      unknownCostRequests: count,
      activeMs: count,
      exhaustedReason: z.string().max(100).nullable(),
    })
    .nullable(),
  model: z.strictObject({ provider: z.string().max(100), id: z.string().max(200) }).nullable(),
  childTasks: z.strictObject({ total: count, done: count, failed: count, running: count }),
  evidence: z.strictObject({ commands: count, screenshots: count, reviews: count }),
  projectNotesChanged: z.boolean().optional(),
  /** How often this reply was continued after hitting the output cap (count only, no text). */
  outputContinuations: count.optional(),
  /** Memory notes injected into this reply's prompts; text is the note as it is now. */
  memories: z
    .strictObject({
      total: z.number().int().nonnegative(),
      items: z
        .array(
          z.strictObject({
            id: IdSchema,
            scope: MemoryScopeSchema.nullable(),
            text: z.string().max(400).nullable(),
          }),
        )
        .max(20),
    })
    .optional(),
  unverified: z.strictObject({
    /** Labels the Bot or the user recorded as not verified (delivery evidence), shortened. */
    items: z
      .array(
        z.strictObject({ label: z.string().min(1).max(200), source: z.enum(["user", "agent"]) }),
      )
      .max(RECEIPT_UNVERIFIED),
    total: count,
    /** The last automatic check of this run did not pass (failed or blocked). */
    failedCheck: z.enum(["failed", "blocked"]).nullable(),
    openTodos: count,
    todoTotal: count,
  }),
  /** Only on workflow runs (a skill with a work contract). */
  delivery: ReceiptDeliverySchema.optional(),
  /**
   * Only on a workflow run that stopped at its cost cap (`budget_exhausted`, ledger reason
   * `cost`). `available` is false once the root had its three raises or a newer run exists; the
   * button calls `runs.resume` with `raiseBudget: true`.
   */
  budgetRaise: z
    .strictObject({
      available: z.boolean(),
      /** The cap the run stopped at, and what one more raise adds (half of the starting cap). */
      capUsd: z.number().positive().finite(),
      raiseUsd: z.number().positive().finite(),
      used: count.max(BUDGET_RAISES_MAX),
      max: z.literal(BUDGET_RAISES_MAX),
    })
    .optional(),
  /** Models this run's child tasks ran on (a `cheap` child shows the auxiliary model). */
  childModels: z
    .array(z.strictObject({ provider: z.string().max(100), id: z.string().max(200) }))
    .max(RECEIPT_CHILD_MODELS)
    .optional(),
  /** Only when some call of this run has an unknown outcome; `total` counts them all. */
  uncertain: z
    .strictObject({
      items: z.array(ReceiptUncertainCallSchema).max(RECEIPT_UNCERTAIN),
      total: count,
    })
    .optional(),
});
export type RunReceipt = z.infer<typeof RunReceiptSchema>;
export type ReceiptDelivery = z.infer<typeof ReceiptDeliverySchema>;
export type DeliveryItem = z.infer<typeof DeliveryItemSchema>;
export type ReceiptBudgetRaise = NonNullable<RunReceipt["budgetRaise"]>;
export type ReceiptUncertainCall = z.infer<typeof ReceiptUncertainCallSchema>;
export type ReceiptBuckets = z.infer<typeof ReceiptBucketsSchema>;
export const RunReceiptMethods = {
  "runs.receipt": {
    params: z.strictObject({ runId: IdSchema }),
    result: RunReceiptSchema,
  },
} as const;
