import type { ExecutionTarget } from "@pibot/execution";
import { checkCoverage, commandKey, verificationCommand } from "./check-commands.ts";
import { type CheckInputs, checkInputs } from "./check-inputs.ts";

export interface CheckScope {
  cwd: string;
  roots: readonly string[];
  authorization: string;
}
interface Receipt {
  scope: string;
  inputs: Pick<CheckInputs, "source" | "dependencies">;
  keys: Set<string>;
  toolCallId: string;
}
export interface PendingCheck {
  scope: CheckScope;
  before: Pick<CheckInputs, "source" | "dependencies">;
  commands: string[][];
  generation: number;
}

/** Owned by one LocalRun: not persisted, not a grant and never transferable to another run. */
export class CheckReceipts {
  private receipts: Receipt[] = [];
  private generation = 0;
  constructor(
    private readonly target: Pick<ExecutionTarget, "readCheckpoint">,
    private readonly safe: (scope: CheckScope) => boolean,
  ) {}
  clear() {
    this.receipts = [];
    this.generation++;
  }
  async begin(
    command: string,
    scope: CheckScope,
    signal: AbortSignal,
  ): Promise<PendingCheck | undefined> {
    const commands = verificationCommand(command, scope.cwd);
    if (!commands || !this.safe(scope)) {
      this.clear();
      return;
    }
    const generation = this.generation;
    const before = await checkInputs(this.target, scope.roots, signal);
    return before && generation === this.generation
      ? {
          scope,
          before: { source: before.source, dependencies: before.dependencies },
          commands,
          generation,
        }
      : undefined;
  }
  async finish(
    pending: PendingCheck | undefined,
    toolCallId: string,
    success: boolean,
    signal: AbortSignal,
  ) {
    if (!success) {
      this.clear();
      return;
    }
    if (!pending || pending.generation !== this.generation || !this.safe(pending.scope)) return;
    const after = await checkInputs(this.target, pending.scope.roots, signal);
    const covers = after
      ? checkCoverage(pending.commands, after.scripts, pending.scope.cwd)
      : new Set<string>();
    if (
      !after ||
      after.source !== pending.before.source ||
      after.dependencies !== pending.before.dependencies
    ) {
      this.clear();
      return;
    }
    if (pending.generation !== this.generation || !this.safe(pending.scope)) return;
    this.receipts.push({
      scope: JSON.stringify(pending.scope),
      inputs: { source: after.source, dependencies: after.dependencies },
      keys: covers,
      toolCallId,
    });
    if (this.receipts.length > 16) this.receipts.shift();
  }
  async reuse(
    command: string,
    scope: CheckScope,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    if (!this.receipts.length || !this.safe(scope)) return;
    const commands = verificationCommand(command, scope.cwd);
    if (!commands) return;
    const generation = this.generation;
    const now = await checkInputs(this.target, scope.roots, signal);
    if (!now || generation !== this.generation || !this.safe(scope)) return;
    const receipt = this.receipts.findLast(
      (r) =>
        r.scope === JSON.stringify(scope) &&
        r.inputs.source === now.source &&
        r.inputs.dependencies === now.dependencies &&
        commands.every((args) => r.keys.has(commandKey(args))),
    );
    return receipt?.toolCallId;
  }
}
