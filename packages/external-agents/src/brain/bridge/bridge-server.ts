// Pi Bot's own MCP server for external agents, the only way an agent reaches
// Pi Bot's tools. Each agent session gets a random token in its `pibot` MCP configuration; the
// relay the agent starts (pibot-mcp-bridge.ts) presents it once per connection. A connection is
// accepted only while that session's topic has a turn running, every call is checked against the
// running turn again, and the token dies with its session. Tokens are never logged or stored.
import { createHash, randomBytes } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { createServer, type Server as NetServer, type Socket } from "node:net";
import type { LocalService, ToolRunContext } from "@pibot/brain/kit";
import { type AgentBridgeEndpoint, agentBridgeSocketPath } from "@pibot/execution";
import { serveToolsOnStream } from "@pibot/plugin-sdk";
import { z } from "zod";
import { relayProgram } from "./bridge-config.ts";
import { bridgeToolListing } from "./bridge-tools.ts";
import { BridgeTurn, OUTSIDE_TURN } from "./bridge-turn.ts";

type TopicKey = { botId: string; conversationId: string };
const keyOf = (key: TopicKey) => `${key.botId}:${key.conversationId}`;

/** The relay's first line; anything else (or nothing within the limit) closes the connection. */
const HelloSchema = z.strictObject({
  pibot: z.literal("bridge/1"),
  token: z.string().regex(/^[a-f0-9]{64}$/),
});
const HELLO_BYTES = 1024;
const HELLO_MS = 5_000;

/** Where the relay connects: an absolute socket path (macOS) or a loopback port (Linux, Windows). */
export type BridgeAddress = { kind: "unix"; path: string } | { kind: "tcp"; port: number };

interface SessionEntry {
  key: TopicKey;
  /** sha256 of the token, hex: looked up by it, so comparing never touches the token. */
  id: string;
  connections: Set<Socket>;
}

export interface BridgeDeps {
  platform: NodeJS.Platform;
  tempDir: string;
  local: LocalService;
  log(level: "info" | "warn", entry: Record<string, unknown>): void;
}

const digestOf = (token: string) => createHash("sha256").update(token).digest("hex");

export class PibotBridge {
  private server?: NetServer;
  private address?: BridgeAddress;
  private socketFolder?: string;
  private starting?: Promise<BridgeAddress | undefined>;
  /** By the sha256 of the token, so the live token itself is kept only in the agent's config. */
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly turns = new Map<string, BridgeTurn>();
  private disposed = false;

  constructor(private readonly deps: BridgeDeps) {}

  /** Listens once; undefined when this platform cannot offer the bridge (the reason is logged). */
  start(): Promise<BridgeAddress | undefined> {
    this.starting ??= this.listen().catch((error: unknown) => {
      this.deps.log("warn", {
        event: "bridge_unavailable",
        reason: error instanceof Error ? error.name : "unknown",
      });
      return undefined;
    });
    return this.starting;
  }

  /** Where the relay connects, once listening. */
  get current() {
    return this.address;
  }

  /** What the agent's sandbox must let it reach (none on Windows: it runs unisolated there). */
  endpoint(): AgentBridgeEndpoint | undefined {
    const address = this.address;
    if (!address || this.deps.platform === "win32") return undefined;
    // The agent starts the relay itself, inside its sandbox: it must be able to read both files
    // (an AppImage keeps them under /tmp, which the agent sandbox hides; Linux acceptance).
    const program = relayProgram();
    const relay = program ? [program.node, program.script] : [];
    return address.kind === "unix"
      ? { kind: "unix", path: address.path, relay }
      : { kind: "tcp", port: address.port, relay };
  }

  private async listen(): Promise<BridgeAddress> {
    const server = createServer({ pauseOnConnect: false }, (socket) => this.accept(socket));
    server.on("error", (error) =>
      this.deps.log("warn", { event: "bridge_server_error", reason: error.name }),
    );
    let address: BridgeAddress;
    if (this.deps.platform === "darwin") {
      // macOS: a unix socket the agent sandbox may connect to by its exact name (and nothing else
      // may create or replace). Linux seccomp refuses AF_UNIX inside the sandbox; Windows has none.
      const { folder, path } = await agentBridgeSocketPath(this.deps.tempDir);
      this.socketFolder = folder;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, () => {
          server.off("error", reject);
          resolve();
        });
      });
      // Owner only (its folder is 0700 too): no other local user may even try a token.
      await chmod(path, 0o600);
      address = { kind: "unix", path };
    } else {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      const info = server.address();
      if (!info || typeof info === "string") throw new Error("bridge_address");
      address = { kind: "tcp", port: info.port };
    }
    if (this.disposed) {
      server.close();
      throw new Error("bridge_disposed");
    }
    this.server = server;
    this.address = address;
    this.deps.log("info", { event: "bridge_listening", transport: address.kind });
    return address;
  }

  /**
   * A new session's credential and its `pibot` MCP entry (ACP `mcpServers`). The token appears
   * only in that entry; Pi Bot keeps its digest.
   */
  issue(key: TopicKey) {
    const token = randomBytes(32).toString("hex");
    const id = digestOf(token);
    this.sessions.set(id, { key, id, connections: new Set() });
    return token;
  }

  /** The session ended (closed, replaced, its process stopped): its token and connections die. */
  revoke(token: string) {
    const id = digestOf(token);
    const entry = this.sessions.get(id);
    if (!entry) return;
    this.sessions.delete(id);
    for (const socket of entry.connections) socket.destroy();
  }

  /** The topic's turn is running: its session's token works until `end`. */
  begin(
    key: TopicKey,
    input: {
      local: LocalService;
      context: ToolRunContext;
      cwd: string;
      cardContext?: ToolRunContext;
    },
  ): BridgeTurn {
    const id = keyOf(key);
    const turn = new BridgeTurn(
      input.local,
      input.cardContext
        ? { ...input.context, approvalCardContext: input.cardContext }
        : input.context,
      input.cwd,
      (entry) =>
        this.deps.log("info", {
          ...entry,
          botId: input.context.botId,
          runId: input.context.runId,
        }),
    );
    this.turns.get(id)?.end();
    this.turns.set(id, turn);
    return turn;
  }

  end(key: TopicKey, turn: BridgeTurn) {
    const id = keyOf(key);
    if (this.turns.get(id) === turn) this.turns.delete(id);
    turn.end();
  }

  private liveTurn(entry: SessionEntry) {
    const turn = this.turns.get(keyOf(entry.key));
    return turn?.live ? turn : undefined;
  }

  private refuse(socket: Socket, reason: string) {
    this.deps.log("warn", { event: "bridge_refused", reason });
    socket.destroy();
  }

  private accept(socket: Socket) {
    let head = Buffer.alloc(0);
    const timer = setTimeout(() => this.refuse(socket, "hello_timeout"), HELLO_MS);
    timer.unref?.();
    socket.on("error", () => socket.destroy());
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf(10);
      if (end < 0) {
        if (head.length > HELLO_BYTES) {
          clearTimeout(timer);
          socket.off("data", onData);
          this.refuse(socket, "hello_invalid");
        }
        return;
      }
      clearTimeout(timer);
      socket.off("data", onData);
      // Keep what followed the hello for the MCP transport, which starts reading below.
      socket.pause();
      const rest = head.subarray(end + 1);
      if (rest.length) socket.unshift(rest);
      this.handshake(socket, head.subarray(0, end));
    };
    socket.on("data", onData);
  }

  private handshake(socket: Socket, line: Buffer) {
    let token: string;
    try {
      token = HelloSchema.parse(JSON.parse(line.toString("utf8"))).token;
    } catch {
      return this.refuse(socket, "hello_invalid");
    }
    const entry = this.sessions.get(digestOf(token));
    if (!entry) return this.refuse(socket, "token_unknown");
    if (!this.liveTurn(entry)) return this.refuse(socket, "outside_turn");
    entry.connections.add(socket);
    socket.on("close", () => entry.connections.delete(socket));
    void this.serve(socket, entry).catch((error: unknown) => {
      this.deps.log("warn", {
        event: "bridge_serve_failed",
        reason: error instanceof Error ? error.name : "unknown",
      });
      socket.destroy();
    });
  }

  private async serve(socket: Socket, entry: SessionEntry) {
    await serveToolsOnStream(socket, {
      name: "pibot",
      title: "Pi Bot",
      version: "1",
      listTools: () => bridgeToolListing(this.deps.local),
      callTool: async (name, args, signal) => {
        // Checked per call: a connection that outlived its turn (the agent keeps its MCP servers
        // between turns) carries nothing over.
        const turn = this.sessions.has(entry.id) ? this.liveTurn(entry) : undefined;
        if (!turn) {
          this.deps.log("warn", { event: "bridge_refused", reason: "outside_turn" });
          return { content: [{ type: "text", text: OUTSIDE_TURN }], isError: true };
        }
        return turn.call(name, args, signal);
      },
    });
    this.deps.log("info", { event: "bridge_connected", botId: entry.key.botId });
  }

  async dispose() {
    this.disposed = true;
    for (const turn of this.turns.values()) turn.end();
    this.turns.clear();
    for (const entry of this.sessions.values())
      for (const socket of entry.connections) socket.destroy();
    this.sessions.clear();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (this.socketFolder) await rm(this.socketFolder, { recursive: true, force: true });
  }
}
