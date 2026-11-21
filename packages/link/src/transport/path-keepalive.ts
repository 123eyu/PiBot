import { z } from "zod";

export type PathKind = "lan" | "punched" | "relay" | "unknown";
export type PathEvent =
  | { event: "path_selected"; path: "direct" | "relay"; kind?: PathKind }
  | { event: "path_lost"; path: "direct" | "relay"; reason: string }
  | { event: "keepalive_on" }
  /** A direct path is ready to switch: `ms` since the attempt began (the offer, on a responder). */
  | { event: "direct_ready"; ms: number; kind?: PathKind }
  /**
   * The round trips that prove a direct path before the switch (path-probe.ts). The initiator
   * says `passed` or the failure code; the responder, when the path was given up before it was
   * selected, says which probe sizes it heard (`heard_none` / `heard_small` / `heard_large`).
   */
  | { event: "direct_probe"; result: string; ms?: number; kind?: PathKind; rttMs?: number }
  /**
   * A selected direct path was given up: messages each way since the switch (`rx` includes the
   * keepalive echo asked for at the switch), ms since the last one heard, and on the side that
   * proved the path, whether ICE moved to another candidate pair since the probes. Both logs
   * together say which direction stopped carrying data.
   */
  | {
      event: "direct_traffic";
      reason: string;
      ms: number;
      rx: number;
      tx: number;
      quietMs: number;
      kind?: PathKind;
      rttMs?: number;
      pairChanged?: 0 | 1;
    };
/** Why a side announces it is leaving, so the other logs a cause instead of a bare close. */
export const PATH_BYE_REASONS = ["drain", "background", "network_change", "user"] as const;
export type PathByeReason = (typeof PATH_BYE_REASONS)[number];
/**
 * End-to-end keepalive on every live path, both directions. Mobile carrier NATs drop idle UDP and
 * TCP mappings in about 30 s; a path that heard nothing for three intervals is dead, so a direct
 * path falls back and a relay-only session ends at once instead of waiting for TCP to time out.
 */
export const KEEPALIVE_MS = 10_000;
export const KEEPALIVE_DEAD_MS = 30_000;
// Loose on purpose: a newer side may add fields. Only both-new sides ever send it (negotiated).
export const KeepaliveSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.literal("link.keepalive"),
  params: z
    .object({
      probe: z.literal(true).optional(),
      bye: z.string().max(32).optional(),
    })
    .optional(),
});
