import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { abortable, type BrainHost, type RegisterRpc } from "@pibot/brain/kit";
import { fileIdentity } from "@pibot/execution";
import {
  type EventPayloads,
  type KnowledgeAccount,
  type KnowledgeTargets,
  type PluginMethodParams,
  type PluginMethodResults,
  RpcError,
  RpcErrorCodes,
} from "@pibot/plugins-contract/full";
import type { KnowledgeRepo } from "../../store/index.ts";
import { knowledgeMissing } from "../../store/knowledge.ts";
import type { VaultAccess } from "../knowledge/obsidian.ts";
import {
  type ReferenceScope,
  referenceCandidate,
  referenceChanged,
  referenceInMessage,
  referenceInvalid,
  referenceScope,
  referenceUnsupported,
  sameReference,
  type VerifiedReference,
  verifyReference,
} from "../knowledge/open-reference.ts";

export type Emit = <K extends keyof EventPayloads>(event: K, payload: EventPayloads[K]) => void;

/**
 * Knowledge sources: the person's Obsidian vaults and Notion workspaces, registered as
 * read-only references. Adding a vault goes through the host folder dialog, so the renderer never
 * hands the brain an arbitrary read root.
 */
export class KnowledgeService {
  /** A second dialog would race the first one and could insert the same vault twice. */
  private picking = false;

  constructor(
    private readonly deps: {
      repo: KnowledgeRepo;
      host: BrainHost;
      emit: Emit;
      shutdown: AbortSignal;
      /** A click names a message, and its Bot/group scope comes from the store. */
      db: DatabaseSync;
      /**
       * The same `read_file` gate the knowledge tools use, rebuilt from the stored reply's
       * Bot/group/conversation. A click is not consent to read a folder the policy denies, and each
       * verification asks again so a decision that changed meanwhile is not remembered.
       */
      readAccess(
        scope: Pick<ReferenceScope, "botId" | "runId" | "conversationId" | "groupId">,
        signal: AbortSignal,
      ): Promise<VaultAccess>;
      /** One audit row per click and its fixed outcome; never the note, path or href. */
      audit(entry: {
        botId: string;
        runId: string;
        sourceId: string;
        status: "requested" | "opened" | "unknown" | "failed";
      }): void;
      /**
       * A Notion source reads through a remote MCP connection this service owns. The connector
       * service creates it and answers whether a stored one still exists, so nothing here touches
       * the pool or the OAuth credential.
       */
      notion: {
        create(): string;
        exists(connectorId: string): boolean;
        /** Copy the source's assignments onto the connection it owns. */
        sync(sourceId: string): void;
        /** Startup repair for installations that predate `selected` + targets. */
        reconcile(): void;
        /** Remove the managed connection when its source goes away. */
        uninstall(connectorId: string): void;
        /** Read the signed-in account through the connection's ordinary call channel. */
        account(
          input: { sourceId: string; connectorId: string; targets: KnowledgeTargets },
          signal: AbortSignal,
        ): Promise<KnowledgeAccount>;
      };
    },
  ) {}

  /**
   * Startup repair for managed connections written before access targets existed. Calling it from
   * capability setup means an upgraded app tightens them before any RPC can read a source.
   */
  reconcile(): void {
    this.deps.notion.reconcile();
  }

  list(params: PluginMethodParams["knowledge.list"]): PluginMethodResults["knowledge.list"] {
    // The list is the knowledge tab's first read after a restart; tightening before it means an
    // upgraded app never shows a source whose connection is still usable by every Bot.
    this.reconcile();
    return this.deps.repo.list(params);
  }

  get(params: PluginMethodParams["knowledge.get"]): PluginMethodResults["knowledge.get"] {
    const source = this.deps.repo.get(params.id);
    if (!source) knowledgeMissing();
    return { source, origin: this.deps.repo.origin(params.id) };
  }

  /**
   * The Notion account of a source. A stored answer is returned as is; a read happens when
   * none is stored or the person asked again (after sign-in, 重试). Answers that made no remote
   * call (not signed in, no Bot given the source) are not kept, so the next open tries again.
   */
  async account(
    params: PluginMethodParams["knowledge.account"],
    signal?: AbortSignal,
  ): Promise<PluginMethodResults["knowledge.account"]> {
    const { repo, notion } = this.deps;
    const source = repo.get(params.id);
    if (!source) knowledgeMissing();
    const origin = repo.origin(params.id);
    if (origin.kind !== "notion") return { account: null };
    const stored = repo.account(params.id);
    if (stored && !params.refresh) return { account: stored };
    const account = await notion.account(
      { sourceId: source.id, connectorId: origin.connectorId, targets: source.targets },
      lifetime(this.deps.shutdown, signal),
    );
    if (account.reason !== "signin" && account.reason !== "no_bot")
      repo.setAccount(source.id, account);
    return { account };
  }

  /**
   * What this computer already keeps. Only names, paths and installed flags come back —
   * no note content is read — and a host without detection (`brain` on a server, tests) answers
   * "nothing found" so the tab still renders its empty state instead of failing.
   */
  async detect(
    _params: PluginMethodParams["knowledge.detect"],
    signal?: AbortSignal,
  ): Promise<PluginMethodResults["knowledge.detect"]> {
    const { host, repo } = this.deps;
    const empty = { obsidian: { installed: false, vaults: [] }, notion: { installed: false } };
    if (!host.knowledge) return empty;
    const detected = await host.knowledge.detect(lifetime(this.deps.shutdown, signal));
    const vaults: PluginMethodResults["knowledge.detect"]["obsidian"]["vaults"] = [];
    const seen = new Set<string>();
    for (const vault of detected.obsidian.vaults) {
      // Canonicalize exactly like adding does, so "already added" is decided on one path and a
      // symlinked or differently cased folder does not show up twice.
      let path: string;
      try {
        path = await realpath(vault.path);
      } catch {
        continue; // the vault disappeared between the host scan and this call
      }
      if (seen.has(path)) continue;
      seen.add(path);
      const existing = repo.findObsidian(path);
      vaults.push({ name: existing?.name ?? vault.name, path, added: existing !== undefined });
    }
    return { ...detected, obsidian: { ...detected.obsidian, vaults } };
  }

  async addObsidian(
    params: PluginMethodParams["knowledge.addObsidian"],
    signal?: AbortSignal,
  ): Promise<PluginMethodResults["knowledge.addObsidian"]> {
    const { host, repo } = this.deps;
    const lifetimeSignal = lifetime(this.deps.shutdown, signal);
    const picker = host.pickFolder;
    if (this.picking) throw new RpcError(RpcErrorCodes.busy, "knowledge_busy");
    this.picking = true;
    try {
      // Same shape as workplaces.pickPath — the host may never answer (a network
      // volume, or a dialog that does not resolve), so the pick is bounded and abortable;
      // otherwise `picking` stays true and every later add is rejected as busy. A vault
      // the host detected is re-checked against a fresh scan under the same bound.
      const pick = AbortSignal.any([lifetimeSignal, AbortSignal.timeout(630_000)]);
      let picked: string | null;
      if (params.detectedPath === undefined) {
        if (!picker) throw new RpcError(RpcErrorCodes.unsupported, "knowledge_picker_unavailable");
        picked = await abortable(picker(pick, { create: false }), pick);
        pick.throwIfAborted();
      } else {
        picked = await detectedVaultPath(host, params.detectedPath, pick);
      }
      if (!picked) return { source: null };
      // The host is a separate process; validate what it returns before treating it as a path.
      if (!isAbsolute(picked) || /[\p{Cc}\p{Cf}]/u.test(picked)) throw vaultInvalid();
      const vault = await vaultFolder(picked, pick);
      // Picking the same vault again returns the existing record instead of a duplicate. If the
      // folder was restored from a backup or replaced by a sync tool, its identity changed while
      // the path stayed the same; refresh the stored identity instead of returning a record that
      // every later read rejects as `knowledge_vault_changed`.
      const existing = repo.findObsidian(vault.path);
      if (existing) {
        const config = repo.origin(existing.id);
        if (
          config.kind === "obsidian" &&
          config.device === vault.identity.device &&
          config.inode === vault.identity.inode
        )
          return { source: existing };
        const updated = repo.repoint(existing.id, {
          kind: "obsidian",
          path: vault.path,
          device: vault.identity.device,
          inode: vault.identity.inode,
        });
        this.deps.emit("knowledge.changed", { id: updated.id, reason: "updated" });
        return { source: updated };
      }
      const source = repo.create({
        kind: "obsidian",
        name: basename(vault.path) || vault.path,
        config: {
          kind: "obsidian",
          path: vault.path,
          device: vault.identity.device,
          inode: vault.identity.inode,
        },
        targets: { all: false, bots: [], groups: [] },
      });
      this.deps.emit("knowledge.changed", { id: source.id, reason: "added" });
      return { source };
    } finally {
      this.picking = false;
    }
  }

  /**
   * Creates the remote MCP connection the source will read through and returns it, so the UI can
   * run `connectors.authorize` next. The connection is installed disabled like any other import:
   * enabling it is exactly what the OAuth grant does.
   */
  addNotion(
    _params: PluginMethodParams["knowledge.addNotion"],
  ): PluginMethodResults["knowledge.addNotion"] {
    const { repo, notion } = this.deps;
    const existing = repo.findNotion();
    if (existing && notion.exists(existing.connectorId)) {
      // A connection installed before this task may still be open to every Bot; copying the
      // source's assignments here repairs it on the same click that opens the source.
      notion.sync(existing.source.id);
      return { source: existing.source, connectorId: existing.connectorId };
    }
    const connectorId = notion.create();
    const config = { kind: "notion" as const, connectorId };
    const source = existing
      ? repo.repoint(existing.source.id, config)
      : repo.create({
          kind: "notion",
          name: "Notion",
          config,
          targets: { all: false, bots: [], groups: [] },
        });
    this.deps.emit("knowledge.changed", {
      id: source.id,
      reason: existing ? "updated" : "added",
    });
    notion.sync(source.id);
    return { source, connectorId };
  }

  update(params: PluginMethodParams["knowledge.update"]): PluginMethodResults["knowledge.update"] {
    const source = this.deps.repo.update({
      ...params,
      targets: { ...params.targets, all: params.targets.all ?? false },
    });
    // The source's "who can use it" and the connection's access row are the same decision.
    this.deps.notion.sync(source.id);
    this.deps.emit("knowledge.changed", { id: source.id, reason: "updated" });
    return source;
  }

  remove(params: PluginMethodParams["knowledge.remove"]): PluginMethodResults["knowledge.remove"] {
    const origin = this.deps.repo.origin(params.id);
    // Only the connection this source created is removed; a vault, the Notion workspace and a
    // connection the person imported themselves are left untouched.
    if (origin.kind === "notion") this.deps.notion.uninstall(origin.connectorId);
    this.deps.repo.remove(params.id);
    this.deps.emit("knowledge.changed", { id: params.id, reason: "removed" });
    return { ok: true };
  }

  /**
   * Opens the note behind a reference in one settled reply. The href is only a hint: the
   * Bot and group come from the stored message, the source from the current assignment, and the
   * host receives identities it re-checks itself before rebuilding the URI.
   */
  async openReference(
    params: PluginMethodParams["knowledge.openReference"],
    signal?: AbortSignal,
  ): Promise<PluginMethodResults["knowledge.openReference"]> {
    const operation = lifetime(this.deps.shutdown, signal);
    const verified = await this.verifyOpen(params, operation);
    const openNote = this.deps.host.knowledge?.openNote;
    // A brain without a desktop host (server, tests) has no way to open an app: say so instead of
    // pretending the click worked or falling back to a file path or a shell command.
    if (!openNote) throw referenceUnsupported();
    // The request is recorded before the host starts reading configuration: a click that hangs or
    // dies in the host still happened, and the record names only the source and the run.
    this.deps.audit({ ...auditScope(verified), status: "requested" });
    try {
      await openNote(
        {
          requestId: randomUUID(),
          sourceId: verified.sourceId,
          vault: {
            path: verified.vaultPath,
            device: verified.vaultIdentity.device,
            inode: verified.vaultIdentity.inode,
          },
          note: {
            relativePath: verified.notePath,
            device: verified.noteIdentity.device,
            inode: verified.noteIdentity.inode,
          },
        },
        operation,
        // Reading Obsidian's own configuration takes seconds, and the person may revoke the source
        // or archive the Bot meanwhile. The host asks once more immediately before the system open,
        // and only a fresh verification of the same reference lets it proceed.
        async () => {
          const again = await this.verifyOpen(params, operation);
          if (!sameReference(verified, again)) throw referenceChanged();
        },
      );
    } catch (error) {
      // "unknown" means the host had already handed the URI to the system: the person may see the
      // note open even though this call failed, so the outcome is recorded as unknown rather than
      // as a failure and the UI does not suggest a blind retry.
      this.deps.audit({
        ...auditScope(verified),
        status: unknownOutcome(error) ? "unknown" : "failed",
      });
      throw error;
    }
    // The system open returned; the row records completion for the same source and run.
    this.deps.audit({ ...auditScope(verified), status: "opened" });
    return { opened: true };
  }

  private async verifyOpen(
    params: PluginMethodParams["knowledge.openReference"],
    operation: AbortSignal,
  ): Promise<VerifiedReference & { botId: string; runId: string }> {
    const scope: ReferenceScope = referenceScope(this.deps.db, params.messageId);
    // The page sends a href it found in the reply; a link this reply never rendered (edited text,
    // another message's id) is refused before any assignment is even looked at.
    if (!(await referenceInMessage(scope.content, params.href))) throw referenceInvalid();
    const candidate = referenceCandidate(this.deps.repo, scope, params.href);
    // Every verification gets its own policy gate, so the answer at confirm time is the current one
    // and not the one from the first click.
    const access = await this.deps.readAccess(scope, operation);
    return {
      ...(await verifyReference(candidate, access)),
      botId: scope.botId,
      runId: scope.runId,
    };
  }
}

/**
 * The dialog returns whatever the person clicked; canonicalizing here keeps duplicate detection
 * and the later reads looking at the same folder (symlinks, trailing separators, case). The
 * identity is recorded once, here, because the folder must be the same entity the person chose:
 * every later query compares against it and asks them to choose again when it moved.
 */
async function vaultFolder(
  picked: string,
  signal: AbortSignal,
): Promise<{ path: string; identity: { device: string; inode: string } }> {
  // Network volumes can hang in realpath/lstat; the pick's own timeout is not enough once the
  // dialog has returned, so the filesystem checks get their own bounded signal.
  const operation = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
  let canonical: string;
  try {
    canonical = await abortable(realpath(picked), operation);
  } catch (error) {
    operation.throwIfAborted();
    if (unreadable(error)) throw vaultUnreadable();
    throw new RpcError(RpcErrorCodes.invalidParams, "knowledge_vault_missing");
  }
  try {
    // Bigint stats: the same encoding execution uses for workspace roots, so NTFS file ids
    // compare exactly instead of through a rounded double.
    const info = await abortable(lstat(canonical, { bigint: true }), operation);
    if (!info.isDirectory()) {
      throw new RpcError(RpcErrorCodes.invalidParams, "knowledge_vault_not_directory");
    }
    return { path: canonical, identity: fileIdentity(info) };
  } catch (error) {
    operation.throwIfAborted();
    if (error instanceof RpcError) throw error;
    if (unreadable(error)) throw vaultUnreadable();
    throw new RpcError(RpcErrorCodes.invalidParams, "knowledge_vault_missing");
  }
}

/** The audit row's fixed fields: which source, which Bot and which run — never the note or href. */
function auditScope(verified: VerifiedReference & { botId: string; runId: string }) {
  return { botId: verified.botId, runId: verified.runId, sourceId: verified.sourceId };
}

/**
 * The host says "unknown" only after it handed the URI to the system: the call failed, but the note
 * may still have opened, so a retry is not safe to suggest and the outcome is recorded as such.
 */
function unknownOutcome(error: unknown): boolean {
  return error instanceof RpcError && error.message === "knowledge_reference_unknown";
}

/** The operation ends when the caller gives up or the brain shuts down, whichever comes first. */
function lifetime(shutdown: AbortSignal, signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, shutdown]) : shutdown;
}

/**
 * A detected vault comes back as a path the renderer echoes. Re-running the host scan
 * keeps this add limited to folders Obsidian itself lists, so a page bug cannot turn it into
 * "read any folder" — the dialog is still the only other way in. Paths are compared canonically
 * because detection already returned them canonicalized.
 */
async function detectedVaultPath(
  host: BrainHost,
  path: string,
  signal: AbortSignal,
): Promise<string> {
  if (!host.knowledge) {
    throw new RpcError(RpcErrorCodes.unsupported, "knowledge_picker_unavailable");
  }
  const wanted = await canonicalOrNull(path);
  const detected = await host.knowledge.detect(signal);
  for (const vault of detected.obsidian.vaults) {
    if ((await canonicalOrNull(vault.path)) === wanted) return wanted;
  }
  throw new RpcError(RpcErrorCodes.invalidParams, "knowledge_vault_not_detected");
}

async function canonicalOrNull(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    // A folder the person moved or deleted since the scan: not a detected vault any more.
    return path;
  }
}

/** Privacy denials and I/O failures are not the same as "the folder was replaced". */
function unreadable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM" || code === "EIO";
}

function vaultInvalid(): RpcError {
  return new RpcError(RpcErrorCodes.invalidParams, "knowledge_vault_invalid");
}

function vaultUnreadable(): RpcError {
  return new RpcError(RpcErrorCodes.invalidParams, "knowledge_vault_unreadable");
}

/** The knowledge RPCs, through brain's single wrapper (validation, logging, error mapping). */
export function registerKnowledgeRpc(handle: RegisterRpc, service: KnowledgeService) {
  handle("knowledge.detect", (params, context) => service.detect(params, context?.signal));
  handle("knowledge.list", (params) => Promise.resolve(service.list(params)));
  handle("knowledge.get", (params) => Promise.resolve(service.get(params)));
  handle("knowledge.account", (params, context) => service.account(params, context?.signal));
  handle("knowledge.addObsidian", (params, context) =>
    service.addObsidian(params, context?.signal),
  );
  handle("knowledge.addNotion", (params) => Promise.resolve(service.addNotion(params)));
  handle("knowledge.update", (params) => Promise.resolve(service.update(params)));
  handle("knowledge.remove", (params) => Promise.resolve(service.remove(params)));
  handle("knowledge.openReference", (params, context) =>
    service.openReference(params, context?.signal),
  );
}
