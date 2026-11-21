import type { DirectFailure, PathByeReason } from "@pibot/link";
import type { MethodParams, MethodResults } from "@pibot/protocol";
import type { Port } from "@pibot/protocol-base";
import type { DesktopCallHandler } from "./desktop-calls.ts";

export interface Computer {
  id: string;
  name: string;
  relay: string;
  publicKey: string;
  safetyCode: string;
}
export interface ChatTarget {
  botId?: string;
  groupId?: string;
  topicId: string;
  threadId?: string;
}
/** A file shared into a conversation, copied into app storage until it is sent. */
export interface PendingFile {
  kind: "image" | "file";
  name: string;
  mimeType: string;
  /** Name in the share store (`share-files.ts`), never a path outside the app. */
  blob: string;
  bytes: number;
}
export interface PendingMessage {
  clientId: string;
  computerId: string;
  target: ChatTarget;
  text: string;
  mentions?: string[];
  files?: PendingFile[];
  createdAt: string;
}
export interface PairResult {
  computer: Computer;
  /** Opaque link credential, stored only in SecureStore; never in React snapshots or logs. */
  credential: string;
}
export interface LinkConnection {
  pulse?(): void;
  setExternalClock?(active: boolean): void;
  port: Port;
  path?: "direct" | "relay" | "lan";
  /**
   * Where a WebRTC direct path runs: on the same network, or through the internet (a hole-punched
   * tunnel). Absent on the relay, on the LAN socket and when the pair could not be classified.
   */
  pathKind?: "lan" | "punched";
  /** Authenticated LAN route hint learned from discovery; never an identity. */
  lanAddress?: string;
  /** Current business generation, independent of the surviving standby path. */
  closed?: AbortSignal;
  onPath?(listener: (connection: LinkConnection) => Promise<void>): () => void;
  onDirectFailure?(listener: (reason: DirectFailure | undefined) => void): () => void;
  networkChanged?(): Promise<void>;
  /**
   * Back in the foreground on the same network: try the LAN upgrade again now, without touching
   * the live session (a resume that called networkChanged rebuilt a healthy link every time).
   */
  refreshLan?(): void;
  /**
   * One continuous authenticated link owner (or a server brain lifetime); absent replays from
   * zero. A desktop that names its event stream in `devices.self` overrides it.
   */
  epoch?: string;
  onClose(listener: () => void): () => void;
  onInteractive?(listener: (state: "available" | "quit") => void): () => void;
  /** `reason` is announced to a computer that understands it (keepalive negotiated). */
  close(reason?: PathByeReason): Promise<void>;
  /** Fixed code for why this connection ended (relay_close_1006, heartbeat_timeout, ...). */
  endReason?(): string | undefined;
  /** A direct path over the relay opened but the business Peer could not bind to it. */
  directBroken?(): boolean;
  /**
   * One liveness round trip after the app was frozen or in the background; false when the path
   * did not answer and was given up (the session then reconnects at once).
   */
  probe?(timeoutMs: number): Promise<boolean>;
  // TODO: bind these to the final remote-contract schemas through the encrypted session.
  self(signal: AbortSignal): Promise<{
    id: string;
    name: string;
    lanAddresses?: string[];
    interactive?: "available" | "quit";
    /**
     * The desktop's event stream for this phone (newer desktops): it outlives this connection,
     * so a reconnect resumes it; `seq` is where it stood when the desktop answered.
     */
    eventStream?: { id: string; seq: number };
  }>;
  /** `attachmentIds`: this session's finished share uploads for the message's files. */
  send(
    message: PendingMessage,
    signal: AbortSignal,
    attachmentIds?: string[],
  ): Promise<MethodResults["chat.send"]>;
  /**
   * Foreground or not, without touching the push token: a phone kept connected in the background
   * (remote-control service) must still get pushes, which the computer skips for a foreground app.
   */
  reportForeground?(foreground: boolean, language: "zh" | "en", signal: AbortSignal): Promise<void>;
  /** null asks the computer to forget this phone's push token (notifications turned off). */
  setPushToken(
    token: string | null,
    language: "zh" | "en",
    signal: AbortSignal,
    wake?: boolean,
  ): Promise<void>;
  /** One slice of a shared file; the last slice's receipt carries the attachment ID. */
  uploadChunk(
    params: MethodParams["remote.share.upload"],
    signal: AbortSignal,
  ): Promise<MethodResults["remote.share.upload"]>;
  /** Which data switches this phone has on for this computer (display only there). */
  supportsEndpointCapabilities?(): boolean;
  /**
   * A local switch changed. Synchronously aborts every in-flight computer call and drops
   * the enabled list, so nothing read under the old switches is sent; the next report restores it.
   */
  invalidatePhoneReads?(): void;
  /** Unpair: permanently closes phone-read admission on this connection. */
  revokePhoneReads?(): void;
  reportPhoneData(
    state: MethodParams["remote.phoneData.state"],
    signal: AbortSignal,
  ): Promise<void>;
  /** Answers the computer's calls to this phone for this session. */
  serve(handler: DesktopCallHandler): () => void;
}
/** Mobile never implements QR/Noise/room cryptography. */
export interface MobileLink {
  pair(qr: string, name: string, signal: AbortSignal): Promise<PairResult>;
  connect(
    computer: Computer,
    credential: string,
    signal: AbortSignal,
    handshakeTimeoutMs: number,
    /**
     * `waitForComputerMs`: how long an open relay room may wait for a computer known to be away
     * (a quiet background attempt); otherwise a room without the computer fails after 5 s.
     * `direct: false`: stay on the relay, never offering the computer a direct upgrade.
     */
    options?: { waitForComputerMs?: number; direct?: boolean },
  ): Promise<LinkConnection>;
}
export type SendParams = MethodParams["chat.send"];
