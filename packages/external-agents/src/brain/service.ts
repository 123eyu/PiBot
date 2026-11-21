import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type BrainRedactor, type LocalService, unusedAvatar } from "@pibot/brain/kit";
import {
  AGENTS,
  type AgentBotSummary,
  type AgentDetection,
  AgentDetectionSchema,
  type AgentSessionOptions,
  agentAllowances,
  agentDescriptor,
  type CustomAgent,
  type DetectedAgent,
  type ExternalAgentId,
  type KnownAgentId,
} from "@pibot/external-agents-contract";
import { type Bot, RpcError } from "@pibot/external-agents-contract/full";
import { AGENT_COLORS, AGENT_LOGOS } from "@pibot/external-agents-contract/logos";
import type { Logger } from "@pibot/observability";
import { BotsRepo, transaction } from "@pibot/storage";
import {
  type AgentBotRecord,
  type AgentPreferences,
  confirmationSubject,
  ExternalAgentBotsRepo,
  ExternalAgentConfirmationsRepo,
  ExternalAgentSessionsRepo,
  mergePreferences,
} from "../store/index.ts";
import { probeAccount } from "./account-probe.ts";
import {
  AgentModelRefused,
  AgentSessions,
  applyModel,
  type OpenInput,
} from "./acp/agent-sessions.ts";
import type { LaunchDeps } from "./acp/launch.ts";
import { withMode, withPreferences, withSetting } from "./acp/session-options.ts";
import { type AdapterAgent, AdapterStore, isAdapterAgent } from "./adapters/adapter-install.ts";
import { CODEX_PROFILE_MODE, codexLauncher } from "./adapters/codex-launch.ts";
import { pibotMcpServer } from "./bridge/bridge-config.ts";
import { PibotBridge } from "./bridge/bridge-server.ts";
import { AgentDelegations } from "./delegation/delegations.ts";
import {
  agentVersion,
  findAgentProgram,
  resolveCustomProgram,
  VersionCache,
} from "./detect/detect.ts";
import { AgentRunError } from "./run/agent-run.ts";

/** A Codex mode saved before Pi Bot hid the ones that cannot run in its sandbox is not applied. */
function workingPreferences(
  agentId: string,
  platform: NodeJS.Platform,
  preferences: AgentPreferences,
): AgentPreferences {
  if (agentId !== "codex" || platform === "win32" || !preferences.mode) return preferences;
  if (preferences.mode === CODEX_PROFILE_MODE || preferences.mode === "agent-full-access")
    return preferences;
  const { mode: _hidden, ...rest } = preferences;
  return rest;
}

export interface ServiceDeps extends LaunchDeps {
  version: string;
  db: DatabaseSync;
  local: LocalService;
  logger: Logger;
  redactor: BrainRedactor;
  language(): "zh" | "en";
  /** The agent changed its options or commands outside a call (views refetch). */
  optionsChanged?(key: { botId: string; conversationId?: string }): void;
  statusChanged?(
    botId: string,
    status: import("@pibot/external-agents-contract").AgentAccountStatus,
  ): void;
}

type Key = { botId: string; conversationId: string };

export class ExternalAgentsService {
  readonly bots: ExternalAgentBotsRepo;
  readonly sessionsRepo: ExternalAgentSessionsRepo;
  readonly confirmations: ExternalAgentConfirmationsRepo;
  readonly adapters: AdapterStore;
  readonly sessions: AgentSessions;
  /** Work other Bots handed to an agent Bot, by the agent run doing it. */
  readonly delegations = new AgentDelegations();
  /** Pi Bot's own MCP server for the agents' sessions. */
  readonly bridge: PibotBridge;
  private readonly accountStatuses = new Map<
    string,
    import("@pibot/external-agents-contract").AgentAccountStatus
  >();

  constructor(private readonly deps: ServiceDeps) {
    this.bots = new ExternalAgentBotsRepo(deps.db);
    this.sessionsRepo = new ExternalAgentSessionsRepo(deps.db);
    this.confirmations = new ExternalAgentConfirmationsRepo(deps.db);
    this.adapters = new AdapterStore(deps.dataDir, deps.proxy);
    this.versions = new VersionCache(join(deps.dataDir, "runtimes", "agent-versions.json"));
    this.bridge = new PibotBridge({
      platform: deps.platform,
      tempDir: deps.tempDir,
      local: deps.local,
      log: (level, entry) =>
        deps.logger[level](JSON.stringify({ module: "external-agents", ...entry })),
    });
    const bridge = this.bridge;
    this.sessions = new AgentSessions(
      {
        ...deps,
        version: deps.version,
        bridge: () => bridge.endpoint(),
        sessionBridge: {
          open: (key) => {
            const address = bridge.current;
            if (!address) return undefined;
            const token = bridge.issue(key);
            const server = pibotMcpServer(address, token);
            if (server) return { token, servers: [server] };
            bridge.revoke(token);
            return undefined;
          },
          revoke: (token) => bridge.revoke(token),
        },
      },
      (entry) => deps.logger.info(JSON.stringify({ module: "external-agents", ...entry })),
      (key, options) => {
        this.sessionsRepo.saveOptions(key.botId, key.conversationId, options);
        this.rememberBotOptions(key.botId, options);
        deps.optionsChanged?.(key);
      },
    );
  }

  accountStatus(botId: string) {
    return (
      this.accountStatuses.get(botId) ?? {
        kind: "unknown" as const,
        checkedAt: null,
        command: null,
      }
    );
  }

  rememberAccountStatus(
    botId: string,
    kind: "unknown" | "login_required" | "quota",
    command: string | null = null,
  ) {
    const record = this.bots.get(botId);
    command ??=
      record && record.agentId !== "custom" ? agentDescriptor(record.agentId).loginCommand : null;
    const status = { kind, checkedAt: new Date().toISOString(), command } as const;
    this.accountStatuses.set(botId, status);
    this.deps.statusChanged?.(botId, status);
  }

  private readonly statusAttempts = new Map<string, number>();
  private readonly statusPending = new Set<string>();

  async checkAccount(botId: string, signal: AbortSignal, force = false) {
    if (this.statusPending.has(botId)) return this.accountStatus(botId);
    if (!force && Date.now() - (this.statusAttempts.get(botId) ?? 0) < 600_000)
      return this.accountStatus(botId);
    const record = this.bots.get(botId);
    if (!record) throw new RpcError(-32602, "Unknown agent Bot");
    this.statusAttempts.set(botId, Date.now());
    this.statusPending.add(botId);
    const prior = this.accountStatus(botId);
    const deadline = AbortSignal.any([
      signal,
      this.deps.local.shutdown.signal,
      AbortSignal.timeout(15_000),
    ]);
    try {
      const isolation = this.isolation(record);
      if (isolation !== "sandbox" && isolation !== "unisolated") return prior;
      if (record.agentId === "custom") return prior;
      const program = await findAgentProgram(record.agentId, this.deps);
      if (!program) return prior;
      const kind = await probeAccount(this.deps, record.agentId, program, deadline, isolation);
      // A concurrent completed run is newer evidence than this probe.
      if (this.accountStatus(botId).checkedAt === prior.checkedAt)
        this.rememberAccountStatus(botId, kind);
    } catch {
      // Unsupported CLI versions, cancellation and inaccessible credentials prove no account state.
    } finally {
      this.statusPending.delete(botId);
    }
    return this.accountStatus(botId);
  }

  /**
   * How this platform runs the agent now. Windows needs the confirmation of exactly this agent
   * (a known agent by id, a custom command by Bot and command digest).
   */
  isolation(
    record: Pick<AgentBotRecord, "botId" | "agentId" | "custom">,
  ): "sandbox" | "unisolated" | "unconfirmed" | "unavailable" {
    if (this.deps.platform === "win32")
      return this.confirmations.confirmed(confirmationSubject(record, record.botId))
        ? "unisolated"
        : "unconfirmed";
    return this.deps.platform === "darwin" || this.deps.platform === "linux"
      ? "sandbox"
      : "unavailable";
  }

  platformIsolation() {
    return this.deps.platform === "win32" ? ("unisolated" as const) : ("sandbox" as const);
  }

  async program(record: Pick<AgentBotRecord, "agentId" | "custom">) {
    if (record.agentId === "custom")
      return record.custom ? resolveCustomProgram(record.custom, this.deps) : undefined;
    return findAgentProgram(record.agentId, this.deps);
  }

  private readonly versions: VersionCache;
  private lastDetection?: AgentDetection;
  private detecting?: Promise<AgentDetection>;

  /**
   * The last result at once (memory, else the copy kept in Pi Bot's data) and a background
   * refresh; `onChange` hears a refresh that differs. Without any earlier result it waits.
   */
  async detection(onChange: (result: AgentDetection) => void, refresh = false) {
    const known = this.lastDetection ?? (await this.storedDetection());
    const fresh = this.refreshDetection(onChange);
    if (known && !refresh) {
      fresh.catch(() => undefined);
      return known;
    }
    return fresh;
  }

  /** One detection at a time; a caller that arrives meanwhile shares it. */
  refreshDetection(onChange: (result: AgentDetection) => void) {
    this.detecting ??= (async () => {
      try {
        const before = this.lastDetection ?? (await this.storedDetection());
        const result: AgentDetection = {
          isolation: this.platformIsolation(),
          agents: await this.detect(AbortSignal.timeout(60_000)),
        };
        this.lastDetection = result;
        if (JSON.stringify(before) !== JSON.stringify(result)) {
          await this.storeDetection(result).catch(() => undefined);
          onChange(result);
        }
        return result;
      } finally {
        this.detecting = undefined;
      }
    })();
    return this.detecting;
  }

  private detectionFile() {
    return join(this.deps.dataDir, "runtimes", "agent-detection.json");
  }
  private async storedDetection() {
    const text = await readFile(this.detectionFile(), "utf8").catch(() => undefined);
    if (!text) return undefined;
    try {
      return AgentDetectionSchema.parse(JSON.parse(text));
    } catch {
      // A damaged copy is only a cache: the next detection replaces it.
      return undefined;
    }
  }
  private async storeDetection(result: AgentDetection) {
    const file = this.detectionFile();
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(result), { mode: 0o600 });
    await rename(temporary, file);
  }

  detect(signal: AbortSignal): Promise<DetectedAgent[]> {
    return Promise.all(AGENTS.map((agent) => this.detectOne(agent.id, signal)));
  }

  async detectOne(id: KnownAgentId, signal: AbortSignal): Promise<DetectedAgent> {
    const agent = agentDescriptor(id);
    const program = await findAgentProgram(id, this.deps);
    const adapter = isAdapterAgent(id)
      ? {
          version: this.adapters.manifest(id).version,
          bytes: agent.launch.kind === "adapter" ? agent.launch.adapter.bytes : 0,
          installed: await this.adapters.installed(id),
        }
      : null;
    return {
      agentId: id,
      installed: !!program,
      program: program ?? null,
      version: program
        ? await agentVersion(
            this.deps,
            id,
            program,
            signal,
            this.versions,
            this.confirmations.confirmed(id),
          )
        : null,
      adapter,
      confirmedUnisolated: this.confirmations.confirmed(id),
    };
  }

  summary(record: AgentBotRecord): AgentBotSummary | undefined {
    const bot = new BotsRepo(this.deps.db).get(record.botId);
    if (!bot) return undefined;
    return {
      botId: record.botId,
      shareUserMemory: this.bots.defaults(record.botId).preferences.shareUserMemory === true,
      name: bot.name,
      agentId: record.agentId,
      custom: record.custom,
      adapterVersion: record.adapterVersion,
      confirmedUnisolated: this.confirmations.confirmed(confirmationSubject(record, record.botId)),
    };
  }

  allowanceView(record: AgentBotRecord) {
    const allowances = agentAllowances(
      { id: record.agentId, custom: record.custom },
      this.deps.platform,
    );
    return {
      readWrite: [...allowances.readWrite].map((path) => `~/${path}`),
      readOnly: [...allowances.readOnly].map((path) => `~/${path}`),
      network: [...allowances.network],
      unixSockets: [...allowances.unixSockets],
    };
  }

  async createBot(params: { agentId: ExternalAgentId; name?: string; custom?: CustomAgent }) {
    if ((params.agentId === "custom") !== !!params.custom)
      throw new AgentRunError("agent_unavailable");
    const record = { agentId: params.agentId, custom: params.custom ?? null };
    if (!(await this.program(record))) throw new AgentRunError("agent_unavailable");
    if (isAdapterAgent(params.agentId) && !(await this.adapters.installed(params.agentId)))
      throw new AgentRunError("agent_unavailable");
    const descriptor = params.agentId === "custom" ? undefined : agentDescriptor(params.agentId);
    const displayName = params.name ?? params.custom?.name ?? descriptor?.name ?? "Agent";
    const zh = this.deps.language() === "zh";
    const description = zh
      ? `外部 Agent：用你电脑上的 ${displayName}，用它自己的账号写代码、改文件、跑命令`
      : `External agent: runs your own ${displayName} with its own account to write code, edit files and run commands`;
    const repo = new BotsRepo(this.deps.db);
    const bot = transaction(this.deps.db, () => {
      const created = repo.create({
        kind: "agent",
        name: this.deps.redactor.redact(displayName),
        systemPrompt: "",
        description,
        isMain: false,
        ...unusedAvatar(new Set()),
        ...(descriptor
          ? { avatarImage: AGENT_LOGOS[descriptor.id], avatarColor: AGENT_COLORS[descriptor.id] }
          : {}),
        modelProvider: null,
        modelId: null,
        thinkingLevel: "off",
        permissionOverrides: {},
        // The agent keeps its own memory; Pi Bot must not send these chats to its own model.
        memoryMode: "ask",
        memoryExtraction: false,
      });
      this.bots.create({
        botId: created.id,
        agentId: params.agentId,
        custom: params.custom ?? null,
        adapterVersion: isAdapterAgent(params.agentId)
          ? this.adapters.manifest(params.agentId).version
          : null,
      });
      return created;
    });
    return bot;
  }

  private async launchTarget(record: AgentBotRecord) {
    const program = await this.program(record);
    if (!program) throw new AgentRunError("agent_unavailable");
    if (record.agentId === "custom")
      return {
        target: { kind: "program" as const, path: program, args: record.custom?.args ?? [] },
        env: {},
      };
    const descriptor = agentDescriptor(record.agentId);
    if (descriptor.launch.kind === "native")
      return {
        target: { kind: "program" as const, path: program, args: descriptor.launch.args },
        env: {},
      };
    const agent = record.agentId as AdapterAgent;
    if (!(await this.adapters.installed(agent))) throw new AgentRunError("agent_unavailable");
    const env: Record<string, string> = { [descriptor.launch.adapter.programEnv]: program };
    const readRoots: string[] = [];
    if (record.agentId === "codex" && this.deps.platform !== "win32") {
      const launcher = await codexLauncher(this.deps.dataDir, program);
      env[descriptor.launch.adapter.programEnv] = launcher.path;
      env.INITIAL_AGENT_MODE = CODEX_PROFILE_MODE;
      readRoots.push(launcher.folder);
    }
    return {
      target: {
        kind: "adapter" as const,
        entry: this.adapters.entry(agent),
        folder: this.adapters.folder(agent),
        ...(readRoots.length ? { readRoots } : {}),
      },
      env,
    };
  }

  async openProcess(
    record: AgentBotRecord,
    _bot: Bot,
    input: {
      conversationId: string;
      cwd: string;
      writeRoots: readonly string[];
      isolation: "sandbox" | "unisolated";
      /** A group plan step: the group's own default folder may be the write root. */
      groupId?: string;
      signal: AbortSignal;
    },
  ) {
    const key = { botId: record.botId, conversationId: input.conversationId };
    const stored = this.sessionsRepo.get(key.botId, key.conversationId);
    // Listening before the first launch: the sandbox can only admit an endpoint that exists.
    await this.bridge.start();
    const open = async () => {
      const launch = await this.launchTarget(record);
      const options: OpenInput = {
        key,
        agentId: record.agentId,
        launch: {
          agent: { id: record.agentId, custom: record.custom },
          target: launch.target,
          env: launch.env,
          cwd: input.cwd,
          writeRoots: input.writeRoots,
          botId: record.botId,
          ...(input.groupId ? { groupId: input.groupId } : {}),
          isolation: input.isolation,
        },
        ...(stored?.sessionId ? { stored: { sessionId: stored.sessionId, cwd: stored.cwd } } : {}),
        // The topic's own picks over the Bot's defaults for new topics.
        preferences: workingPreferences(
          record.agentId,
          this.deps.platform,
          mergePreferences(this.bots.defaults(record.botId).preferences, stored?.preferences ?? {}),
        ),
        ...(record.agentId === "claude"
          ? {
              // Claude's own sandbox cannot nest in Pi Bot's; bypass mode stays unavailable.
              sessionMeta: {
                claudeCode: {
                  options: { sandbox: { enabled: false }, allowDangerouslySkipPermissions: false },
                },
              },
              // "default" asks before edits and commands, so Pi Bot's policy decides them.
              defaultMode: "default",
            }
          : {}),
        signal: input.signal,
      };
      return this.sessions.open(options);
    };
    // No retry without Codex's profile: its default mode would start Codex's own sandbox, which
    // cannot nest in Pi Bot's, and its full-access mode never asks. Failing is the honest result.
    const process = await open();
    this.sessionsRepo.save(key.botId, key.conversationId, {
      sessionId: process.sessionId,
      cwd: input.cwd,
      options: process.options,
    });
    this.rememberBotOptions(key.botId, process.options);
    return process;
  }

  async prewarm(
    record: AgentBotRecord,
    input: {
      conversationId: string;
      cwd: string;
      writeRoots: readonly string[];
      isolation: "sandbox" | "unisolated";
      signal: AbortSignal;
    },
  ) {
    await this.bridge.start();
    const launch = await this.launchTarget(record);
    const stored = this.sessionsRepo.get(record.botId, input.conversationId);
    return this.sessions.prewarm({
      key: { botId: record.botId, conversationId: input.conversationId },
      agentId: record.agentId,
      launch: {
        agent: { id: record.agentId, custom: record.custom },
        target: launch.target,
        env: launch.env,
        cwd: input.cwd,
        writeRoots: input.writeRoots,
        botId: record.botId,
        isolation: input.isolation,
      },
      ...(stored?.sessionId ? { stored: { sessionId: stored.sessionId, cwd: stored.cwd } } : {}),
      preferences: workingPreferences(
        record.agentId,
        this.deps.platform,
        mergePreferences(this.bots.defaults(record.botId).preferences, stored?.preferences ?? {}),
      ),
      signal: input.signal,
    });
  }

  /**
   * The Bot's last known options. A session that opened before the agent loaded its lists (Cursor:
   * an empty model list) keeps the lists the Bot already knew instead of erasing them.
   */
  private rememberBotOptions(botId: string, options: AgentSessionOptions) {
    const known = this.bots.defaults(botId).options;
    this.bots.saveOptions(botId, {
      ...options,
      mode: options.mode?.options.length ? options.mode : (known?.mode ?? options.mode),
      model: options.model?.options.length ? options.model : (known?.model ?? options.model),
      settings: options.settings.length ? options.settings : (known?.settings ?? []),
      commands: options.commands.length ? options.commands : (known?.commands ?? []),
    });
  }

  private readonly optionRefreshAttempted = new Set<string>();
  private readonly optionRefreshes = new Map<string, Promise<void>>();
  private readonly lifetime = new AbortController();

  /** No prompt or bridge token: discovery cannot execute a delegated Pi Bot action. */
  refreshDefaultOptions(record: AgentBotRecord) {
    const options = this.bots.defaults(record.botId).options;
    if (
      this.lifetime.signal.aborted ||
      this.optionRefreshAttempted.has(record.botId) ||
      (options && (!options.model || options.model.options.length > 0))
    )
      return;
    this.optionRefreshAttempted.add(record.botId);
    const work = this.probeDefaultOptions(record)
      .catch(() =>
        this.deps.logger.warn(
          JSON.stringify({
            module: "external-agents",
            event: "agent_options_refresh_failed",
            botId: record.botId,
          }),
        ),
      )
      .finally(() => this.optionRefreshes.delete(record.botId));
    this.optionRefreshes.set(record.botId, work);
  }

  private async probeDefaultOptions(record: AgentBotRecord) {
    const isolation = this.isolation(record);
    if (isolation !== "sandbox" && isolation !== "unisolated") return;
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(120_000)]);
    const launch = await this.launchTarget(record);
    const cwd = join(this.deps.dataDir, "bots", record.botId, "home");
    await mkdir(cwd, { recursive: true });
    // Discovery also leaves an empty session in the agent's history, even without a prompt.
    const sessions = new AgentSessions({ ...this.deps, version: this.deps.version }, () => {});
    let options: AgentSessionOptions;
    try {
      const session = await sessions.open({
        key: { botId: record.botId, conversationId: record.botId },
        agentId: record.agentId,
        launch: {
          agent: { id: record.agentId, custom: record.custom },
          target: launch.target,
          env: launch.env,
          cwd,
          writeRoots: [cwd],
          botId: record.botId,
          isolation,
        },
        preferences: {},
        ...(record.agentId === "claude"
          ? {
              sessionMeta: {
                claudeCode: {
                  options: { sandbox: { enabled: false }, allowDangerouslySkipPermissions: false },
                },
              },
            }
          : {}),
        signal,
      });
      options = session.options;
      // Discovery publishes only after its own process has confirmed shutdown.
      await session.connection.close();
    } finally {
      await sessions.dispose();
    }
    signal.throwIfAborted();
    // A normal turn may have populated the defaults while discovery was running.
    if (
      !options.model?.options.length ||
      !this.bots.get(record.botId) ||
      this.bots.defaults(record.botId).options?.model?.options.length
    )
      return;
    this.rememberBotOptions(record.botId, options);
    this.deps.optionsChanged?.({ botId: record.botId });
  }

  /** A topic's options with its picks, else the Bot's last offered options with its defaults. */
  options(botId: string, conversationId?: string): AgentSessionOptions {
    return this.present(botId, this.rawOptions(botId, conversationId));
  }

  private rawOptions(botId: string, conversationId?: string): AgentSessionOptions {
    const empty = { mode: null, model: null, settings: [], commands: [], refusedModel: null };
    const defaults = this.bots.defaults(botId);
    if (!conversationId) return withPreferences(defaults.options ?? empty, defaults.preferences);
    const live = this.sessions.get({ botId, conversationId })?.options;
    if (live) return live;
    const stored = this.sessionsRepo.get(botId, conversationId);
    return withPreferences(
      stored?.options ?? defaults.options ?? empty,
      mergePreferences(defaults.preferences, stored?.preferences ?? {}),
    );
  }

  /**
   * Codex under Pi Bot's sandbox (macOS / Linux): its own sandboxed modes (Read-only, Workspace
   * access, Auto review) fail every command, because Codex's sandbox cannot nest in Pi Bot's
   * (`sandbox_apply: Operation not permitted`). Only the modes that work are offered: Pi Bot's
   * permission profile under a readable name, and Codex's full access.
   */
  private present(botId: string, options: AgentSessionOptions): AgentSessionOptions {
    if (
      this.bots.get(botId)?.agentId !== "codex" ||
      this.deps.platform === "win32" ||
      !options.mode
    )
      return options;
    const zh = this.deps.language() === "zh";
    const working = options.mode.options
      .filter((item) => item.id === CODEX_PROFILE_MODE || item.id === "agent-full-access")
      .map((item) =>
        item.id === CODEX_PROFILE_MODE
          ? {
              ...item,
              name: zh ? "Pi Bot 沙箱（不逐条询问）" : "Pi Bot sandbox (no per-command asks)",
            }
          : item,
      );
    return working.length ? { ...options, mode: { ...options.mode, options: working } } : options;
  }

  /**
   * In a topic: remembered for it and as the Bot's default, applied now when the agent is idle,
   * else when its session opens. Without a topic: the Bot's default only.
   */
  async setOption(
    botId: string,
    conversationId: string | undefined,
    change: { kind: "mode" | "model" | "config"; configId?: string; value: string },
    signal: AbortSignal,
  ) {
    const patch: AgentPreferences =
      change.kind === "config" && change.configId
        ? { config: { [change.configId]: change.value } }
        : { [change.kind]: change.value };
    // The topic's own session, idle: another topic's turn on the same process does not matter,
    // the change names this session only.
    const session = conversationId ? this.sessions.get({ botId, conversationId }) : undefined;
    const live = session && !session.active && !session.connection.isClosed ? session : undefined;
    if (live && conversationId) {
      const options = live.options;
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
      const offered = (list?: { options: { id: string }[] } | null) =>
        !!list?.options.some((option) => option.id === change.value);
      // The agent's answer decides a typed model id; a refusal keeps the old choice and is shown.
      if (change.kind === "model")
        await applyModel(live, change.value, deadline).catch((error: unknown) => {
          if (error instanceof AgentModelRefused) throw new RpcError(-32602, "agent_model_refused");
          throw error;
        });
      if (change.kind === "mode" && offered(options.mode)) {
        await live.connection.request(
          "session/set_mode",
          { sessionId: live.sessionId, modeId: change.value },
          deadline,
        );
        live.options = withMode(options, change.value);
      }
      const setting =
        change.kind === "config"
          ? options.settings.find((item) => item.configId === change.configId)
          : undefined;
      if (setting && offered(setting)) {
        await live.connection.request(
          "session/set_config_option",
          { sessionId: live.sessionId, configId: setting.configId, value: change.value },
          deadline,
        );
        live.options = withSetting(options, setting.configId, change.value);
      }
      this.sessionsRepo.saveOptions(botId, conversationId, live.options);
      this.rememberBotOptions(botId, live.options);
    }
    // Remembered after the agent accepted it (or, with no live session, for its next start).
    this.bots.setDefault(botId, patch);
    if (conversationId) this.sessionsRepo.setPreference(botId, conversationId, patch);
    return this.options(botId, conversationId);
  }

  /** Stops the process serving the topic, with any other topic's idle session on it. */
  stopProcess(key: Key) {
    return this.sessions.stop(`${key.botId}:${key.conversationId}`);
  }
  releaseProcess(key: Key) {
    this.sessions.release(key);
    // Linux: bubblewrap's deny placeholders (.claude/settings.json, opencode.json, ...) exist in
    // the user's folder for as long as the sandbox runs, and removing them under a live sandbox
    // would lift those denies inside it. So the agent stops after each turn (its placeholders are
    // removed on exit) and the next turn resumes its session with session/load; the cost is the
    // agent's start time per turn on Linux (OpenCode ~7 s on kali, 2026-11-14). Topics that share
    // the process lose nothing: a released process runs no other turn, and they resume likewise.
    if (this.deps.platform === "linux")
      void this.sessions
        .stop(`${key.botId}:${key.conversationId}`)
        .catch(() =>
          this.deps.logger.warn(
            JSON.stringify({ module: "external-agents", event: "stop_failed" }),
          ),
        );
  }
  stderrTail(key: Key) {
    return this.sessions.get(key)?.connection.stderrTail();
  }
  async dispose() {
    this.lifetime.abort();
    await Promise.allSettled(this.optionRefreshes.values());
    await this.sessions.dispose();
    await this.bridge.dispose();
  }

  knownAgent(id: ExternalAgentId): id is KnownAgentId {
    return id !== "custom";
  }
}
