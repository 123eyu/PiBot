import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  LocalService,
  ToolRunContext,
  UnattendedSendIntent,
  UnattendedSendLedger,
} from "@pibot/brain/kit";
import { migratedOutputPath, migrateLegacyOutputs } from "@pibot/brain/kit";
import type { Logger } from "@pibot/observability";
import { containsPath } from "@pibot/policy";
import {
  type Message,
  type Routine,
  type RoutineLedgerDelivery,
  type RoutineLedgerFile,
  RoutineLedgerFileSchema,
  type RoutineLedgerInput,
  RoutineLedgerInputSchema,
  type RoutineLedgerOutputSkip,
  type RoutineLedgerSend,
  RoutineLedgerSendSchema,
  type RoutineRun,
  type RoutineRunLedger,
  RoutineRunLedgerSchema,
} from "@pibot/protocol";
import { type LedgerRow, RoutineRunLedgerRepo, type RoutineRunsRepo } from "../../store/index.ts";
import { fileFacts, listFiles, realDirectory } from "./files.ts";
import { type LedgerFacts, ledgerText } from "./ledger-text.ts";
import { outputSegments, periodKey } from "./period.ts";

interface Context {
  periodKey: string | null;
  outputFolder: string | null;
  outputSkipped: RoutineLedgerOutputSkip | null;
  previous: { runId: string; periodKey: string; folder: string } | null;
  /** Read-only folders that were skipped because they no longer exist (names only). */
  skipped: string[];
  /** The Bot-level default was stale, so this run used the Bot home. */
  workplaceFallback?: boolean;
  workplace?: Workplace;
}
export interface PreparedLedger {
  periodKey: string | null;
  outputFolder: string | null;
  workplace: Workplace;
  /** Read-only folders the run receives (the previous period's), canonical paths. */
  temporaryPaths: string[];
  text: string | undefined;
}
type Workplace = NonNullable<ToolRunContext["routineWorkplace"]>;
const occurrenceOf = (run: RoutineRun) => run.occurrenceId ?? run.id;
const fileKey = (path: string) => createHash("sha256").update(path).digest("hex").slice(0, 32);
const ended = new Set(["done", "failed", "cancelled", "timeout"]);
const staleWorkplaceCodes = new Set([
  "workplace_folder_missing",
  "Unknown working folder",
  "Working folder changed; associate it again",
]);
const isStaleWorkplaceError = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "message" in error &&
  staleWorkplaceCodes.has(String(error.message));

/**
 * The run ledger of routine runs. It records what a run processed, produced and
 * sent, gives each intended external send an idempotency key that stays the same across the
 * attempts of one occurrence, and lays out the per-period artifact folders.
 */
export class RoutineLedger implements UnattendedSendLedger {
  readonly repo: RoutineRunLedgerRepo;
  constructor(
    private readonly deps: {
      db: DatabaseSync;
      local: LocalService;
      runs: RoutineRunsRepo;
      logger: Logger;
    },
  ) {
    this.repo = new RoutineRunLedgerRepo(deps.db);
  }
  private context(id: string): Context | undefined {
    return this.repo.get(id, "context", "run")?.facts as Context | undefined;
  }
  temporaryPaths(id: string) {
    const previous = this.context(id)?.previous;
    return previous ? [previous.folder] : [];
  }

  workplace(id: string, requested: Workplace): Workplace {
    // The durable receipt owns this decision: a restored Bot default must not move a parked run.
    const context = this.context(id);
    if (context?.workplace) return context.workplace;
    return context?.workplaceFallback
      ? { kind: "folder", folderId: "home", readonly: [] }
      : requested;
  }

  /** Lays out folders and records inputs once per run; a re-publish reuses what was recorded. */
  async prepare(
    record: RoutineRun,
    routine: Routine | undefined,
    workplace: Workplace,
    trigger: Message,
    carry: boolean,
    signal: AbortSignal,
  ): Promise<PreparedLedger> {
    const occurrence = occurrenceOf(record);
    let context = this.context(record.id);
    if (!context) {
      context = await this.layout(record, routine, workplace, signal);
      const inputs = await this.inputs(record, context, trigger, signal);
      this.repo.putAll(record.id, occurrence, [
        { kind: "context", key: "run", facts: context },
        ...inputs.map((input) => ({ kind: "input" as const, key: inputKey(input), facts: input })),
      ]);
    }
    const inputs = this.inputsOf(record.id);
    const earlier = this.deps.runs
      .attempts(occurrence)
      .filter((r) => r.id !== record.id && r.createdAt <= record.createdAt && ended.has(r.status));
    const last =
      carry && !earlier.length && routine
        ? this.deps.runs.lastDone(routine.id, record.id)
        : undefined;
    const facts: LedgerFacts = {
      periodKey: context.periodKey,
      outputFolder: context.outputFolder,
      previous: context.previous && {
        ...context.previous,
        files: await this.previousFiles(routine?.id, context.previous, signal),
      },
      existing: inputs.flatMap((i) => (i.kind === "existing_output" ? [i.file] : [])),
      skipped: context.skipped,
      workplaceFallback: context.workplaceFallback,
      triggerFiles: inputs.flatMap((i) => (i.kind === "trigger_file" ? [i.file] : [])),
      earlier: earlier.map((r) => ({
        status: r.status,
        errorCode: r.errorCode,
        sends: this.sends(r.id),
        outputs: this.outputs(r.id),
      })),
      lastRun: last ? { sends: this.sends(last.id), outputs: this.outputs(last.id) } : null,
    };
    return {
      periodKey: context.periodKey,
      outputFolder: context.outputFolder,
      workplace: this.workplace(record.id, workplace),
      temporaryPaths: context.previous ? [context.previous.folder] : [],
      text: ledgerText(facts),
    };
  }

  private async layout(
    record: RoutineRun,
    routine: Routine | undefined,
    workplace: Workplace,
    signal: AbortSignal,
  ): Promise<Context> {
    if (!routine)
      return {
        periodKey: null,
        outputFolder: null,
        outputSkipped: "trial",
        previous: null,
        skipped: [],
      };
    const key = periodKey(routine, record, Intl.DateTimeFormat().resolvedOptions().timeZone);
    this.deps.runs.setPeriod(record.id, key);
    let boundary: Awaited<ReturnType<LocalService["workplaces"]["context"]>>["boundary"];
    let skipped: string[] = [];
    let workplaceFallback = false;
    const selection =
      workplace.kind === "folder" && workplace.folderId
        ? { primary: workplace.folderId, readonly: workplace.readonly ?? [] }
        : this.deps.local.workplaces.initial(record.botId);
    let selectedWorkplace: Workplace =
      workplace.kind === "bot"
        ? { kind: "folder", folderId: selection.primary, readonly: selection.readonly }
        : workplace;
    try {
      const resolved = await this.deps.local.workplaces.context(record.botId, signal, {
        selection,
        revision: 0,
      });
      boundary = resolved.boundary;
      skipped = resolved.gone?.map((folder) => folder.name) ?? [];
    } catch (error) {
      signal.throwIfAborted();
      const stale = workplace.kind === "bot" && isStaleWorkplaceError(error);
      if (!stale) {
        this.deps.logger.warn(`Routine output folder unavailable run=${record.id}`);
        return {
          periodKey: key,
          outputFolder: null,
          outputSkipped: "unavailable",
          previous: null,
          skipped: [],
          workplace: selectedWorkplace,
        };
      }
      const fallback = await this.deps.local.workplaces.context(record.botId, signal, {
        selection: { primary: "home", readonly: [] },
        revision: 0,
      });
      boundary = fallback.boundary;
      skipped = fallback.gone?.map((folder) => folder.name) ?? [];
      workplaceFallback = true;
      selectedWorkplace = { kind: "folder", folderId: "home", readonly: [] };
      this.deps.logger.warn(`Routine workplace stale; fell back to Bot home run=${record.id}`);
    }
    const platform = this.deps.local.deps.platform;
    const folder = join(boundary.primaryPath, ...outputSegments(routine), key);
    if (!routine.output.enabled)
      return {
        periodKey: key,
        outputFolder: null,
        outputSkipped: "disabled",
        previous: null,
        skipped,
        workplaceFallback,
        workplace: selectedWorkplace,
      };
    const skip = (outputSkipped: RoutineLedgerOutputSkip): Context => ({
      periodKey: key,
      outputFolder: null,
      outputSkipped,
      previous: null,
      skipped,
      workplaceFallback,
      workplace: selectedWorkplace,
    });
    if (boundary.conflict !== "none" || !containsPath(boundary.primaryPath, folder, platform))
      return skip("outside_primary");
    // Read-only references (and watched folders) inside the primary are never written into.
    if (boundary.denyWriteRoots.some((root) => containsPath(root, folder, platform)))
      return skip("readonly");
    if (await linkedOnTheWay(boundary.primaryPath, folder)) return skip("outside_primary");
    // Earlier periods move to `.pibot/out` before they are looked up (idempotent).
    await migrateLegacyOutputs(boundary.primaryPath, signal).catch(() => signal.throwIfAborted());
    const prior = this.deps.runs.previousPeriod(routine.id, key, record.scheduledFor);
    const priorFolder = prior ? this.context(prior.id)?.outputFolder : undefined;
    // A period written before the move to `.pibot/out` is read from where it was moved.
    const movedFolder = priorFolder ? migratedOutputPath(priorFolder) : undefined;
    const previousFolder = priorFolder
      ? ((await realDirectory(priorFolder)) ??
        (movedFolder ? await realDirectory(movedFolder) : undefined))
      : undefined;
    return {
      periodKey: key,
      outputFolder: folder,
      outputSkipped: null,
      skipped,
      workplaceFallback,
      workplace: selectedWorkplace,
      previous:
        // Only inside today's primary: the extra root then grants no new reads, it only stops
        // writes into the previous period (see withoutTemporaryRoots).
        prior?.periodKey &&
        previousFolder &&
        previousFolder !== folder &&
        containsPath(boundary.primaryPath, previousFolder, platform)
          ? { runId: prior.id, periodKey: prior.periodKey, folder: previousFolder }
          : null,
    };
  }

  private async inputs(
    record: RoutineRun,
    context: Context,
    trigger: Message,
    signal: AbortSignal,
  ) {
    const inputs: RoutineLedgerInput[] = [];
    const resumed = record.resumeOf ? this.inputsOf(record.resumeOf) : [];
    // A resume has no trigger of its own: it processes what the interrupted attempt received.
    const triggerFiles = resumed.length
      ? resumed.flatMap((i) => (i.kind === "trigger_file" ? [i.file] : []))
      : await fileFacts(trigger.routineTrigger?.paths ?? [], false, signal);
    for (const file of triggerFiles.slice(0, 50)) inputs.push({ kind: "trigger_file", file });
    const github = trigger.routineTrigger?.github?.events.length;
    if (github) inputs.push({ kind: "github_events", count: github });
    const connection = trigger.routineTrigger?.connection?.changed;
    if (connection) inputs.push({ kind: "connection_items", count: connection });
    const calendar = trigger.routineTrigger?.calendar?.total;
    if (calendar) inputs.push({ kind: "calendar_events", count: calendar });
    const current = context.outputFolder ? await realDirectory(context.outputFolder) : undefined;
    if (current)
      for (const file of await fileFacts(await listFiles(current, signal), false, signal))
        inputs.push({ kind: "existing_output", file });
    if (context.previous)
      inputs.push({
        kind: "previous_period",
        ...context.previous,
        files: Math.min(
          1000,
          this.periodFiles(
            record.routineId ?? undefined,
            context.previous.periodKey,
            context.previous.folder,
          ).length,
        ),
      });
    return inputs.slice(0, 200);
  }

  /** Records the files this run produced: its period folder plus other files it changed. */
  async settle(id: string, executionRunId: string | null, signal: AbortSignal) {
    const run = this.deps.runs.require(id);
    const folder = this.context(id)?.outputFolder;
    const real = folder ? await realDirectory(folder) : undefined;
    const inFolder = real ? await listFiles(real, signal) : [];
    let touched: string[] = [];
    if (executionRunId && this.deps.local.workspaceServices)
      touched = (await this.deps.local.changes.turn.touched(executionRunId))
        .filter((path) => !inFolder.includes(path))
        .slice(0, 50);
    const files = await fileFacts([...inFolder, ...touched], true, signal);
    this.repo.putAll(
      id,
      occurrenceOf(run),
      files.map((file) => ({ kind: "output" as const, key: fileKey(file.path), facts: file })),
    );
  }

  intend(context: ToolRunContext, intent: UnattendedSendIntent) {
    const id = context.routineRunId as string;
    const run = this.deps.runs.require(id);
    const occurrence = occurrenceOf(run);
    const rows = this.repo.list(id, "send");
    const replay = rows.find((row) => row.facts.callDigest === intent.callDigest);
    let key = replay?.key;
    if (!key) {
      // The n-th send to one target is the same intended send in every attempt of an occurrence.
      const ordinal = rows.filter(
        (row) =>
          row.facts.connectorId === intent.connectorId &&
          row.facts.tool === intent.tool &&
          row.facts.targetDigest === intent.targetDigest,
      ).length;
      key = createHash("sha256")
        .update(
          JSON.stringify([
            occurrence,
            intent.connectorId,
            intent.tool,
            intent.targetDigest,
            ordinal,
          ]),
        )
        .digest("hex")
        .slice(0, 32);
      this.repo.put(id, occurrence, "send", key, {
        ...intent,
        target: intent.target.slice(0, 500),
        ordinal,
        approvalId: null,
        duplicateOf: null,
        at: new Date().toISOString(),
      });
    }
    const earlier = this.repo
      .inOccurrence(occurrence, "send", key, id)
      .flatMap((row) => [row.facts.approvalId, row.facts.duplicateOf])
      .filter((value): value is string => typeof value === "string");
    return { key, earlier: [...new Set(earlier)] };
  }
  bind(id: string, key: string, approvalId: string) {
    this.patchSend(id, key, { approvalId });
  }
  duplicate(id: string, key: string, approvalId: string) {
    this.patchSend(id, key, { duplicateOf: approvalId });
  }
  private patchSend(id: string, key: string, patch: Record<string, string>) {
    const row = this.repo.get(id, "send", key);
    if (!row) throw new TypeError("Unknown routine send intent");
    this.repo.put(id, row.occurrenceId, "send", key, { ...row.facts, ...patch });
  }

  view(id: string): RoutineRunLedger {
    const run = this.deps.runs.require(id);
    const context = this.context(id);
    return RoutineRunLedgerSchema.parse({
      routineRunId: id,
      occurrenceId: occurrenceOf(run),
      attempts: this.deps.runs.attempts(occurrenceOf(run)).map((r) => r.id),
      periodKey: run.periodKey ?? context?.periodKey ?? null,
      outputFolder: context?.outputFolder ?? null,
      outputSkipped: context?.outputSkipped ?? null,
      ...(context?.workplaceFallback ? { workplaceFallback: true } : {}),
      inputs: this.inputsOf(id),
      outputs: this.outputs(id),
      sends: this.sends(id).slice(0, 200),
    });
  }

  private inputsOf(id: string) {
    return valid(this.repo.list(id, "input"), RoutineLedgerInputSchema);
  }
  private outputs(id: string) {
    return valid(this.repo.list(id, "output"), RoutineLedgerFileSchema).slice(0, 400);
  }
  /**
   * The recorded manifest, or (when the previous run ended before its manifest was written, e.g. a
   * restart) the folder as it is now: names and sizes, no content and no hashing on this path.
   */
  private async previousFiles(
    routineId: string | undefined,
    previous: NonNullable<Context["previous"]>,
    signal: AbortSignal,
  ) {
    const recorded = this.periodFiles(routineId, previous.periodKey, previous.folder);
    if (recorded.length) return recorded;
    const folder = await realDirectory(previous.folder);
    return folder ? fileFacts(await listFiles(folder, signal), false, signal) : [];
  }
  /** The previous period's manifest: outputs of every run of that period inside its folder. */
  private periodFiles(routineId: string | undefined, key: string, folder: string) {
    if (!routineId) return [];
    const platform = this.deps.local.deps.platform;
    const latest = new Map<string, RoutineLedgerFile>();
    for (const run of this.deps.runs.inPeriod(routineId, key))
      for (const file of this.outputs(run.id))
        if (!latest.has(file.path) && containsPath(folder, file.path, platform))
          latest.set(file.path, file);
    return [...latest.values()];
  }
  private sends(id: string): RoutineLedgerSend[] {
    const drafts = this.deps.local.drafts.repo;
    return this.repo.list(id, "send").flatMap((row) => {
      const approvalId = typeof row.facts.approvalId === "string" ? row.facts.approvalId : null;
      const duplicateOf = typeof row.facts.duplicateOf === "string" ? row.facts.duplicateOf : null;
      const status = approvalId ? drafts.get(approvalId)?.view.status : undefined;
      const delivery: RoutineLedgerDelivery = duplicateOf ? "duplicate" : (status ?? "none");
      const parsed = RoutineLedgerSendSchema.safeParse({
        key: row.key,
        connectorId: row.facts.connectorId,
        tool: row.facts.tool,
        target: row.facts.target,
        contentDigest: row.facts.contentDigest,
        ordinal: row.facts.ordinal,
        approvalId,
        duplicateOf,
        delivery,
        at: row.facts.at ?? row.createdAt,
      });
      return parsed.success ? [parsed.data] : [];
    });
  }
}

function inputKey(input: RoutineLedgerInput) {
  if (input.kind === "trigger_file" || input.kind === "existing_output")
    return `${input.kind}:${fileKey(input.file.path)}`;
  if (input.kind === "previous_period") return `previous_period:${input.runId}`;
  return input.kind;
}
// Rows are written by this module; a row that no longer parses (older shape) is left out, not fatal.
function valid<T>(
  rows: LedgerRow[],
  schema: { safeParse(v: unknown): { success: boolean; data?: T } },
) {
  return rows.flatMap((row) => {
    const parsed = schema.safeParse(row.facts);
    return parsed.success && parsed.data !== undefined ? [parsed.data] : [];
  });
}
/** A link on the way from the primary to the output folder could lead writes elsewhere. */
async function linkedOnTheWay(primary: string, folder: string) {
  const rest = folder.slice(primary.length).split(/[\\/]/).filter(Boolean);
  let current = primary;
  for (const segment of rest) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) return true;
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(String((error as { code?: unknown }).code))) return false;
      throw error;
    }
  }
  return false;
}
