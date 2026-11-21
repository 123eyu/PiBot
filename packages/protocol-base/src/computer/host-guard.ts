import { z } from "zod";
import { IdSchema } from "../core/ids.ts";
import { ComputerAppIdSchema, MAX_COMPUTER_APPS, plainText } from "./apps.ts";

// brain → background process (host) calls for the protections around operating the computer
//The always-on-top indicator, the global stop shortcut, Apple Events
// consent warm-up and the user-editable blocklist mirror. The host never decides anything
// here: it shows what brain says and reports the user's clicks back through `actions`.

const label = (max: number) => z.string().trim().min(1).max(max).refine(plainText);

export const ComputerGuardModeSchema = z.enum(["background", "foreground", "paused", "waiting"]);
/** One row of the indicator: one Bot's run that currently holds an operation grant. */
export const ComputerGuardEntrySchema = z.strictObject({
  botId: IdSchema,
  runId: IdSchema,
  botName: label(80),
  /** The Bot's avatar colour name (e.g. "blue"); the bar's blinking dot uses the same colour. */
  botColor: z
    .string()
    .regex(/^[a-z]{1,20}$/)
    .optional(),
  apps: z.array(label(200)).min(1).max(MAX_COMPUTER_APPS),
  mode: ComputerGuardModeSchema,
  pausedBy: z.enum(["user", "activity", "locked"]).nullable(),
  /** Short description of the current or pending foreground step; never typed text. */
  step: label(200).nullable(),
  /** A foreground step waiting for "Allow / Skip" (foregroundAsk). */
  confirm: z.strictObject({ requestId: IdSchema, action: label(200) }).nullable(),
});
export const ComputerGuardActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.enum(["pause", "resume", "stop"]), botId: IdSchema }),
  // The global shortcut stops every run that holds a grant.
  z.strictObject({ kind: z.literal("stopAll") }),
  z.strictObject({ kind: z.literal("foreground"), requestId: IdSchema, allow: z.boolean() }),
]);

export const HostComputerGuardMethods = {
  /** Full snapshot; an empty list hides the indicator and unregisters the stop shortcut. */
  "host.computerGuard.update": {
    params: z.strictObject({
      language: z.enum(["zh", "en"]),
      entries: z.array(ComputerGuardEntrySchema).max(20),
    }),
    result: z.null(),
  },
  /** Long poll for indicator clicks and the stop shortcut; returns early when anything arrives. */
  "host.computerGuard.actions": {
    params: z.strictObject({ waitMs: z.number().int().min(0).max(25_000) }),
    result: z.strictObject({ actions: z.array(ComputerGuardActionSchema).max(50) }),
  },
  /**
   * Sends one harmless Apple Event to each running app so macOS shows its Automation consent
   * while the user is present. Fire-and-forget; other platforms report unsupported.
   */
  "host.computerGuard.prepareAutomation": {
    params: z.strictObject({ apps: z.array(ComputerAppIdSchema).min(1).max(MAX_COMPUTER_APPS) }),
    result: z.strictObject({ supported: z.boolean(), triggered: z.number().int().nonnegative() }),
  },
  /** The user-editable part of the blocklist, mirrored into the driver's app check. */
  "host.computerGuard.blocklist": {
    params: z.strictObject({ appIds: z.array(ComputerAppIdSchema).max(500) }),
    result: z.null(),
  },
} as const;

export type ComputerGuardEntry = z.infer<typeof ComputerGuardEntrySchema>;
export type ComputerGuardAction = z.infer<typeof ComputerGuardActionSchema>;
export type ComputerGuardMode = z.infer<typeof ComputerGuardModeSchema>;
export type HostComputerGuardMethod = keyof typeof HostComputerGuardMethods;
export type HostComputerGuardParams = {
  [K in HostComputerGuardMethod]: z.input<(typeof HostComputerGuardMethods)[K]["params"]>;
};
export type HostComputerGuardResults = {
  [K in HostComputerGuardMethod]: z.output<(typeof HostComputerGuardMethods)[K]["result"]>;
};
