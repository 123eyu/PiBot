import { relative, resolve, sep } from "node:path";
import type { LocalToolResult } from "@pibot/agent";
import {
  captureProject,
  createSemanticService,
  SemanticError,
  type SemanticSnapshot,
} from "@pibot/execution/semantic";
import { CodeNavigateResultSchema, CodeNavigateSchema, RpcError } from "@pibot/protocol-base";
import type { PreparedTool, ToolRunContext } from "../../core/local-types.ts";
import { redactValue } from "../../core/privacy.ts";
import type { LocalService } from "../../local-service.ts";
import type { LocalRun } from "../tools/local-run.ts";
import { diagnosticsStillCurrent, diagnosticVersions } from "./diagnostic-versions.ts";
import { type EditDiagnostics, postEditDiagnostics } from "./post-edit-diagnostics.ts";
import { assertFrozenAccess, reviewSourceAccess } from "./review-source-access.ts";
import { semanticFileCache } from "./semantic-cache.ts";

export class CodeNavigationService {
  private readonly service = createSemanticService();
  private readonly circuits = new Map<
    string,
    { fingerprint: string; failures: number; reason?: string; at: number }
  >();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly late = new WeakMap<
    ToolRunContext,
    { root: string; path: string; result: EditDiagnostics }[]
  >();
  private readonly running = new WeakSet<ToolRunContext>();
  constructor(private readonly local: LocalService) {}
  async afterEdit(context: ToolRunContext, root: string, path: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.running.has(context)) return { status: "unavailable", reason: "pending", lines: [] };
    this.running.add(context);
    let deferred = false;
    const task = postEditDiagnostics(
      this.local,
      this.service,
      context,
      root,
      path,
      context.signal,
      this.circuits,
    );
    this.pending.add(task);
    void task
      .then((result) => {
        if (deferred && result && !context.signal.aborted) {
          const ready = this.late.get(context) ?? [];
          ready.push({ root, path, result });
          this.late.set(context, ready.slice(-8));
        }
      })
      .finally(() => {
        this.running.delete(context);
        this.pending.delete(task);
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        task,
        new Promise<EditDiagnostics>((resolve) => {
          timer = setTimeout(() => {
            deferred = true;
            resolve({
              status: "unavailable",
              reason: "pending",
              lines: [],
              notice:
                "诊断仍在后台进行，稍后工具结果会附上。 / Diagnostics continue in the background and will accompany a later tool result.",
            });
          }, 3000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async takeLate(context: ToolRunContext, signal: AbortSignal) {
    const ready = this.late.get(context) ?? [];
    this.late.delete(context);
    const results: EditDiagnostics[] = [];
    for (const item of ready) {
      if (!item.result.sourceHash) {
        results.push(item.result);
        continue;
      }
      try {
        const access = await reviewSourceAccess(this.local, context, item.root, signal, {
          directOnly: true,
        });
        const versions = item.result[diagnosticVersions];
        if (!versions) continue;
        if (await diagnosticsStillCurrent(access, versions)) results.push(item.result);
      } catch {
        // Revocation or a changed source discards optional late output; the write remains complete.
      }
    }
    return results;
  }
  async snapshot(
    context: ToolRunContext,
    snapshot: SemanticSnapshot,
    input: unknown,
    signal: AbortSignal,
    // Snapshot readers can name the actual tool in audit without changing the frozen read path.
    auditTool = "code_navigate",
  ): Promise<LocalToolResult> {
    const args = CodeNavigateSchema.parse(input);
    if (args.path !== undefined) {
      if (!/\.[cm]?[jt]sx?$/.test(args.path)) throw new SemanticError("unsupported_language");
    }
    const path =
      args.path === undefined
        ? undefined
        : relative(snapshot.root, resolve(snapshot.root, args.path)).split(sep).join("/");
    if (path !== undefined && !snapshot.files.some((f) => f.path === path))
      throw new SemanticError("invalid_input", "semantic_file_unavailable");
    const access = await reviewSourceAccess(this.local, context, snapshot.root, signal);
    // Recheck every immutable member: a snapshot is not a permission bypass after revocation.
    await assertFrozenAccess(snapshot, access);
    const result = CodeNavigateResultSchema.parse(
      redactValue(
        await this.service.query(snapshot, { ...args, path }, signal),
        this.local.deps.redactor,
      ),
    );
    await assertFrozenAccess(snapshot, access);
    this.local.approvals.audit.append({
      botId: context.botId,
      runId: context.runId,
      kind: "exec.finished",
      summary: "Semantic navigation completed",
      detail: {
        toolName: auditTool,
        reasonCode: result.partial ? "partial" : "complete",
        target: result.snapshotHash,
      },
    });
    return {
      text: JSON.stringify(result),
      summary: `TypeScript ${result.engineVersion}${result.partial ? " · partial / 部分结果" : ""}`,
    };
  }
  async execute(run: LocalRun, prepared: PreparedTool, input: unknown, signal: AbortSignal) {
    const current = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    try {
      if (prepared.result.path?.path !== prepared.cwd)
        throw new RpcError(-32602, "semantic_root_consent_required");
      const args = CodeNavigateSchema.parse(input);
      const access = await reviewSourceAccess(this.local, run.context, prepared.cwd, current, {
        cache: semanticFileCache(run.context, prepared.cwd),
      });
      // The target anchors import-chain selection when the project exceeds the snapshot file limit.
      return this.snapshot(
        run.context,
        await captureProject(access, false, args.path === undefined ? [] : [args.path]),
        input,
        current,
      );
    } catch (error) {
      if (signal.aborted) throw error;
      // A 15 s overrun and a dead worker both reached brain as `tool_failed`.
      if (error instanceof SemanticError) throw error;
      if (current.aborted) throw new SemanticError("timeout");
      if (error instanceof Error && error.message === "project_unavailable")
        throw new SemanticError("unavailable", error.message);
      throw error;
    }
  }
  async dispose() {
    await this.service.dispose();
    await Promise.allSettled([...this.pending]);
  }
}
