import {
  ExecError,
  issueOutsideSandboxPermit,
  rememberableSystemService,
  type SandboxBlock,
  type SandboxBlockItem,
} from "@pibot/execution";
import {
  LISTED_OUTSIDE_SANDBOX_REASON,
  listedOutsideFilters,
  OUTSIDE_SANDBOX_REASON,
  type OutsideSandboxFacts,
  type Platform,
} from "@pibot/policy";
import type { PreparedTool } from "../../core/local-types.ts";

/**
 * Kinds that only leaving the sandbox can get past; writePaths covers outside writes. A CLI's own
 * login (credential_read) is the user's to use in their terminal, so an approved outside run may
 * read it; other protected locations (protected_path / protected_read) stay closed.
 */
const ESCAPABLE = new Set([
  "protected_name",
  "git_resource",
  "network",
  // Recorded so the same call can come back as the local-service card (macOS) or the
  // run-outside card (elsewhere).
  "local_service",
  "system_service",
  "credential_read",
  "other",
]);
const MAX_RECORDS = 64;

interface Recorded {
  cwd: string;
  consumed: boolean;
  block: SandboxBlock;
}

/**
 * Blocks this run's commands actually hit, by the call shape the model sent. A run
 * outside the sandbox is only offered for a block recorded here, and each record is spent once.
 */
export class SandboxBlockRegistry {
  private readonly records = new Map<string, Recorded>();
  private readonly repeats = new Map<string, number>();
  private readonly notices = new Map<string, { id: string; call: string; cwd: string }>();

  noticeRecorded(kind: string, rule: string, domain = "") {
    return this.notices.size >= MAX_RECORDS || this.notices.has(`${kind}\0${rule}\0${domain}`);
  }
  rememberNotice(
    kind: string,
    rule: string,
    id: string,
    call: { command: string; cwd?: string },
    cwd: string,
    domain = "",
  ) {
    // Notices share the run's bounded diagnostic budget; existing records are never evicted and
    // emitted again during a retry loop.
    if (this.notices.size < MAX_RECORDS)
      this.notices.set(`${kind}\0${rule}\0${domain}`, {
        id,
        call: SandboxBlockRegistry.key(call.command, call.cwd),
        cwd,
      });
  }
  noticeIds(call: { command: string; cwd?: string }, cwd: string) {
    const key = SandboxBlockRegistry.key(call.command, call.cwd);
    return [...this.notices.values()]
      .filter((notice) => notice.call === key && notice.cwd === cwd)
      .map((notice) => notice.id);
  }

  private static key(command: string, cwd: string | undefined) {
    return `${cwd ?? ""}\0${command}`;
  }

  /** True when the block can be offered a run outside the sandbox. */
  record(call: { command: string; cwd?: string }, resolvedCwd: string, block: SandboxBlock) {
    // Pi Bot's data, browser profiles and other protected locations stay closed even outside.
    if (
      block.kinds.includes("protected_path") ||
      block.kinds.includes("protected_read") ||
      !block.kinds.some((kind) => ESCAPABLE.has(kind))
    )
      return false;
    const key = SandboxBlockRegistry.key(call.command, call.cwd);
    const repeatKey = `${key}\0${[...block.kinds].sort().join(",")}`;
    const repeated = (this.repeats.get(repeatKey) ?? 0) + 1;
    this.repeats.delete(repeatKey);
    this.repeats.set(repeatKey, repeated);
    // Bounded like the records: a run that keeps trying new commands must not grow this forever.
    if (this.repeats.size > MAX_RECORDS * 4) {
      const oldest = this.repeats.keys().next().value;
      if (oldest !== undefined) this.repeats.delete(oldest);
    }
    this.records.delete(key);
    this.records.set(key, { cwd: resolvedCwd, consumed: false, block });
    if (this.records.size > MAX_RECORDS) {
      const oldest = this.records.keys().next().value;
      if (oldest !== undefined) this.records.delete(oldest);
    }
    return true;
  }

  available(call: { command: string; cwd?: string }) {
    const record = this.records.get(SandboxBlockRegistry.key(call.command, call.cwd));
    return !!record && !record.consumed;
  }
  localService(call: { command: string; cwd?: string }) {
    const record = this.records.get(SandboxBlockRegistry.key(call.command, call.cwd));
    return record && !record.consumed
      ? record.block.items.find((item) => item.kind === "local_service")
      : undefined;
  }
  systemService(call: { command: string; cwd?: string }) {
    const record = this.records.get(SandboxBlockRegistry.key(call.command, call.cwd));
    if (!record || record.consumed) return undefined;
    for (const item of record.block.items) {
      if (item.kind !== "system_service") continue;
      const service = item.rule.includes(".") ? item.rule : item.target;
      if (rememberableSystemService(service)) return service;
    }
    return undefined;
  }
  repeatCount(call: { command: string; cwd?: string }, block: SandboxBlock) {
    return (
      this.repeats.get(
        `${SandboxBlockRegistry.key(call.command, call.cwd)}\0${[...block.kinds].sort().join(",")}`,
      ) ?? 0
    );
  }

  consume(call: { command: string; cwd?: string }, resolvedCwd: string) {
    const record = this.records.get(SandboxBlockRegistry.key(call.command, call.cwd));
    if (!record || record.consumed || record.cwd !== resolvedCwd) return false;
    record.consumed = true;
    return true;
  }
}

/** Pure facts for policy; the decision (deny / danger ask, listed match) is policy's alone. */
export function outsideSandboxFacts(input: {
  platform: NodeJS.Platform;
  local: boolean;
  args: {
    command: string;
    cwd?: string;
    background?: boolean;
    docker?: boolean;
    writePaths?: string[];
  };
  recipe: boolean;
  readonlyRoots: boolean;
  strict: boolean;
  listed: readonly string[];
  automatic?: readonly string[];
  registry: SandboxBlockRegistry | undefined;
  localService?: SandboxBlockItem;
  systemService?: string;
}): OutsideSandboxFacts {
  if (
    (input.platform !== "darwin" && input.platform !== "linux") ||
    !input.local ||
    input.args.background ||
    input.args.docker ||
    input.args.writePaths?.length ||
    input.recipe ||
    input.readonlyRoots
  )
    return { status: "unavailable", reason: "unsupported" };
  if (input.strict) return { status: "unavailable", reason: "strict" };
  return {
    status: "eligible",
    blockRecorded: input.registry?.available(input.args) ?? false,
    ...(input.systemService ? { systemService: input.systemService } : {}),
    listed: [...input.listed],
    automatic: [...(input.automatic ?? [])],
    ...(input.localService?.kind === "local_service"
      ? {
          localService: {
            kind: "local_service" as const,
            rule: input.localService.rule,
            target: input.localService.target,
          },
        }
      : {}),
  };
}

/**
 * Last check before dispatch: the exact confirmed call, then the record is spent and execution
 * receives a one-time permit bound to this command and folder.
 */
export function outsideSandboxPermit(
  prepared: PreparedTool,
  registry: SandboxBlockRegistry | undefined,
  /** The user's current list and platform: a listed line names the filters exec must verify. */
  listing: {
    patterns: readonly string[];
    automatic?: readonly string[];
    strict?: boolean;
    platform: Platform;
  },
) {
  const input = prepared.call.input as {
    command?: unknown;
    cwd?: unknown;
    outsideSandbox?: unknown;
  };
  const automatic = prepared.result.facts.some(
    (fact) => fact.kind === "warning" && fact.value === "sandbox_outside_auto",
  );
  if (automatic) {
    const filters =
      typeof input.command === "string" &&
      !listing.strict &&
      listedOutsideFilters(
        input.command,
        prepared.result.analysis,
        listing.automatic ?? [],
        listing.platform,
      );
    if (
      !filters ||
      (prepared.result.decision !== "allow" &&
        !(prepared.result.decision === "ask" && prepared.confirmedNow))
    )
      throw new ExecError("authorization_changed");
    return issueOutsideSandboxPermit({
      command: input.command as string,
      cwd: prepared.cwd,
      filters,
    });
  }
  const listed = prepared.result.reason === LISTED_OUTSIDE_SANDBOX_REASON;
  // Policy sends a program that needs the person's own login (gh, aws…) straight to
  // the outside-sandbox card. The person confirmed that outside run on the card, so it must not
  // silently run sandboxed when the model left outsideSandbox unset (acceptance 2026-11-16:
  // `gh api` was approved as outside and ran inside); there is no earlier block to spend either.
  const fixed = prepared.result.facts.some(
    (fact) => fact.kind === "warning" && fact.value === "outside_sandbox_login",
  );
  if (input.outsideSandbox !== true && !listed && !fixed) return undefined;
  if (
    prepared.call.tool !== "run_command" ||
    typeof input.command !== "string" ||
    (input.cwd !== undefined && typeof input.cwd !== "string") ||
    prepared.confirmedNow !== true ||
    prepared.result.decision !== "ask" ||
    (prepared.result.reason !== OUTSIDE_SANDBOX_REASON && !listed) ||
    prepared.result.canRemember ||
    prepared.result.grantScope ||
    // A listed command has no block record to spend; its permit is still single-use.
    (!listed &&
      !fixed &&
      !registry?.consume({ command: input.command, cwd: input.cwd }, prepared.cwd))
  )
    throw new ExecError("authorization_changed");
  // A person confirmed this exact line on the card; a listed line was matched by shape only, so
  // the stdin filters it relies on are re-derived now and checked against PATH at dispatch.
  const filters = listed
    ? listedOutsideFilters(
        input.command,
        prepared.result.analysis,
        listing.patterns,
        listing.platform,
      )
    : [];
  if (!filters) throw new ExecError("authorization_changed");
  return issueOutsideSandboxPermit({ command: input.command, cwd: prepared.cwd, filters });
}
