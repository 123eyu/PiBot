import type { DirectFailure, LinkPath, PathByeReason, PathEvent } from "@pibot/link";
import type { Port } from "@pibot/protocol-base";

export interface EndpointIdentity {
  publicKey: string;
  privateKey: string;
}
export interface PairedPhone {
  kind?: "phone" | "runner";
  publicKey: string;
  name: string;
  room: string;
  roomSecret: string;
  securityCode: string;
}
export interface LinkSession {
  select?(): void;
  activate?(): Promise<void>;
  runnerPath?: "lan" | "address" | "punched" | "relay";
  port: Port;
  /** A retired socket also retires its Peer; the owner reconnects with a new handshake. */
  signal?: AbortSignal;
  /** Runner relay sessions: fixed codes for why the session ended, once it has. */
  ended?(): { stage: string; reason: string } | undefined;
  /** Phone sessions: fixed code for why the session ended (peer_left, heartbeat_timeout, ...). */
  endReason?(): string | undefined;
  /** Phone sessions: speaks the end-to-end link keepalive (advertised in devices.self). */
  keepalive?: true;
  /** Phone sessions announce `reason` to a phone that understands it before closing. */
  close(reason?: PathByeReason): Promise<void>;
  onPresence(listener: (online: boolean) => void): () => void;
  currentPath?(): LinkPath;
  onPath?(listener: (path: LinkPath) => Promise<void>): () => void;
  onDirectFailure?(listener: (reason: DirectFailure | undefined) => void): () => void;
}
/**
 * T1 owns cryptography and room protocol. Success confirms real I/O drain; a runner drain
 * failure hands its retained cleanup owner back through RunnerDrainError. Close/revoke are
 * idempotent. No implementation lives here.
 */
export interface RemoteLinkPort {
  readonly kind: "link" | "development";
  readonly officialRelayUrl?: string;
  /** Disables and drains every LAN listener before settings/power teardown continues. */
  configureLan?(enabled: boolean): Promise<void>;
  connectRunnerPunch?(input: {
    identity: EndpointIdentity;
    publicKey: string;
    port: Port;
    stunUrl: string;
    signal: AbortSignal;
  }): Promise<LinkSession>;
  connectRunnerDirect?(input: {
    punch?: (signal: AbortSignal) => Promise<LinkSession>;
    identity: EndpointIdentity;
    publicKey: string;
    roomSecret: string;
    addresses: readonly string[];
    signal: AbortSignal;
  }): Promise<LinkSession>;
  /** Authenticated-session route hints; callers must treat them as untrusted addresses. */
  lanAddresses?(roomSecret: string): string[];
  createIdentity(signal: AbortSignal): Promise<EndpointIdentity>;
  pairRunner?(input: {
    identity: EndpointIdentity;
    relayUrl: string;
    name: string;
    code: string;
    generated?: boolean;
    onPeer?(): void;
    signal: AbortSignal;
    commit(device: PairedPhone): Promise<void>;
  }): Promise<void>;
  pair(input: {
    identity: EndpointIdentity;
    relayUrl: string;
    name: string;
    expiresAt: string;
    signal: AbortSignal;
  }): Promise<{
    payload: string;
    completed: Promise<PairedPhone>;
    close(): Promise<void>;
  }>;
  /** Phones reconnect internally; runner generations and retry timing belong to RunnerConnections. */
  connect(input: {
    stunUrl?: string;
    kind?: "phone" | "runner";
    identity: EndpointIdentity;
    publicKey: string;
    room: string;
    roomSecret: string;
    relayUrl: string;
    signal: AbortSignal;
    onPhase?(phase: "socket_open" | "waiting_presence" | "handshake" | "closed"): void;
    /** Phone sessions: path lifecycle as fixed codes, for the desktop's phone-link log. */
    onEvent?(event: PathEvent): void;
  }): Promise<LinkSession>;
  push(input: {
    relayUrl: string;
    room: string;
    roomSecret: string;
    token: string;
    kind: "approval" | "run_done" | "run_failed" | "wake";
    route: Record<string, string>;
    language: "zh" | "en";
    signal: AbortSignal;
  }): Promise<void>;
  /** Retires the local room key; the stateless relay may still admit an empty old room. */
  revoke(input: {
    relayUrl: string;
    room: string;
    roomSecret: string;
    signal: AbortSignal;
  }): Promise<void>;
}
