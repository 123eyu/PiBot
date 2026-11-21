import { z } from "zod";
import { IdSchema } from "../core/ids.ts";
import {
  ComputerAppIdListSchema,
  ComputerAppIdSchema,
  ComputerAppListSchema,
  ComputerAppSchema,
  ComputerGrantDurationSchema,
  plainText,
} from "./apps.ts";

export * from "./apps.ts";

const time = z.iso.datetime();
const botId = z.strictObject({ botId: IdSchema });
const label = (max: number) => z.string().trim().min(1).max(max).refine(plainText);

// ---- Grants and the always-list -----------------------------------------------------------

/** Renderer view of an operation grant. The token itself never leaves brain; only its hash is stored. */
export const ComputerGrantSchema = z.strictObject({
  id: IdSchema,
  botId: IdSchema,
  runId: IdSchema,
  apps: ComputerAppIdListSchema,
  duration: ComputerGrantDurationSchema,
  expiresAt: time,
  foregroundAsk: z.boolean(),
  allowCoordinates: z.boolean(),
  createdAt: time,
  revokedAt: time.nullable(),
});
/**
 * The list must be non-empty and has no coordinate option by construction, so "always"
 * can never include screenshot clicks. The blocklist check needs the database and lives in the
 * store repository (`BotComputerAlwaysRepo.set`).
 */
export const ComputerAlwaysSchema = z.strictObject({
  botId: IdSchema,
  apps: ComputerAppListSchema,
  updatedAt: time,
});
export const GroupComputerAlwaysSchema = ComputerAlwaysSchema.omit({ botId: true }).extend({
  groupId: IdSchema,
});
export const ScopedComputerAlwaysSchema = z.union([
  ComputerAlwaysSchema,
  GroupComputerAlwaysSchema,
]);
export const ComputerAlwaysScopeSchema = z.union([
  botId.extend({ groupId: z.never().optional() }),
  z.strictObject({ groupId: IdSchema, botId: z.never().optional() }),
]);
export const ComputerBlocklistEntrySchema = z.strictObject({
  appId: ComputerAppIdSchema,
  name: label(200),
  source: z.enum(["default", "user"]),
  removable: z.boolean(),
  // A removable suggestion the user unticked; listed so the UI can show it unchecked.
  removed: z.boolean().optional(),
});
export const ComputerSettingsSchema = z.strictObject({
  screenshotRetentionDays: z.number().int().min(1).max(30),
});

// ---- Steps, live state and system permissions ---------------------------------------------

export const ComputerStepMethodSchema = z.enum(["ui", "browser", "coordinates", "keys"]);
export const ComputerStepResultSchema = z.enum(["done", "error", "denied", "skipped"]);
/**
 * The step stopped on a "come help for a moment" card. `waiting` while the card is open;
 * `continued` after the user handled it (the retry's own outcome is `result`); `not_handled`
 * after "no thanks", the timeout or a stop.
 */
export const ComputerStepHandoffSchema = z.enum(["waiting", "continued", "not_handled"]);
/**
 * What a step did, stored as data so the UI phrases it in the current language. Older
 * rows (and steps without a fixed verb) only have the pre-phrased `target`.
 */
export const ComputerStepActionSchema = z.strictObject({
  kind: z.enum([
    "open",
    "click",
    "type",
    "select",
    "scroll",
    "back",
    "close_tab",
    "screenshot",
    "login",
    "open_app",
    "open_file",
  ]),
  /** Site host, element ref, tab id, app or file name; never typed text. */
  subject: z.string().max(300).refine(plainText).optional(),
  /** `type`: how many characters were typed (the text itself is never stored). */
  chars: z.number().int().nonnegative().max(1_000_000).optional(),
  /** `type`: Enter was pressed after typing. */
  submit: z.boolean().optional(),
  direction: z.enum(["up", "down", "left", "right"]).optional(),
});
/** The page a Bot browser step left the Bot on (shown in Records, hover for full URL). */
export const ComputerStepPageSchema = z.strictObject({
  url: z.string().max(2048).refine(plainText),
  title: z.string().max(500).refine(plainText),
});
/**
 * One recorded action. Screenshots are referenced, never inlined: the renderer fetches the
 * thumbnail with `computer.screenshot.thumbnail` only when the step is on screen.
 */
export const ComputerStepSchema = z.strictObject({
  id: IdSchema,
  botId: IdSchema,
  runId: IdSchema,
  toolCallId: label(200),
  app: ComputerAppSchema,
  method: ComputerStepMethodSchema,
  stage: z.enum(["background", "foreground"]),
  // Element description or "x,y" in screenshot pixels; never typed text or field values.
  target: z.string().max(500).refine(plainText),
  result: ComputerStepResultSchema,
  hasScreenshot: z.boolean(),
  createdAt: time,
  action: ComputerStepActionSchema.optional(),
  page: ComputerStepPageSchema.optional(),
  handoff: ComputerStepHandoffSchema.optional(),
});
/** A foreground step waiting on its conditions (ask, user idle, screen unlocked, foreground lock). */
export const ComputerForegroundSchema = z.strictObject({
  requestId: IdSchema,
  app: ComputerAppSchema,
  action: z.string().trim().min(1).max(200).refine(plainText),
  status: z.enum(["asking", "queued", "waiting_idle", "waiting_unlock", "running"]),
  queuePosition: z.number().int().positive().optional(),
});
export const ComputerRunStateSchema = z.enum([
  "idle",
  "background",
  "foreground",
  "paused",
  "stopped",
]);
export const ComputerStateSchema = z.strictObject({
  botId: IdSchema,
  runId: IdSchema.nullable(),
  state: ComputerRunStateSchema,
  app: ComputerAppSchema.nullable(),
  pausedBy: z.enum(["user", "activity", "locked"]).nullable(),
  foreground: ComputerForegroundSchema.nullable(),
  // Activity is the HID idle clock minus the driver's own injections; locked rejects foreground.
  userActive: z.boolean(),
  screenLocked: z.boolean(),
  stepCount: z.number().int().nonnegative().safe(),
  grant: ComputerGrantSchema.nullable(),
});
export const ComputerPermissionKindSchema = z.enum(["accessibility", "screen", "automation"]);
export const ComputerPermissionsSchema = z.strictObject({
  platform: z.enum(["darwin", "win32", "linux"]),
  available: z.boolean(),
  // Why the whole capability is off on this machine; drives a plain-language notice in the UI.
  unavailableReason: z
    .enum([
      "unsupported_platform",
      "non_interactive_session",
      "wayland_limited",
      "driver_missing",
      "permission_missing",
    ])
    .nullable(),
  items: z
    .array(
      z.strictObject({
        kind: ComputerPermissionKindSchema,
        // Automation (Apple Events) cannot be queried silently, so it stays "unknown" until used.
        status: z.enum(["granted", "denied", "not_determined", "unknown", "not_required"]),
      }),
    )
    .max(3),
});

/** Renderer view of `host.computer.installedApps`; `category` marks default suggestions. */
export const ComputerInstalledAppsSchema = z.discriminatedUnion("supported", [
  z.strictObject({
    supported: z.literal(true),
    apps: z
      .array(ComputerAppSchema.extend({ category: z.enum(["chat", "mail"]).optional() }))
      .max(2000),
    truncated: z.boolean(),
  }),
  z.strictObject({ supported: z.literal(false), reason: z.string().max(200) }),
]);

// ---- Methods and events -------------------------------------------------------------------

/**
 * Resolves a `category: "computer"` approval with the card's extended payload. Deny carries no
 * options so a denied card can never create a grant by accident.
 */
export const ComputerGrantResolveSchema = z.discriminatedUnion("decision", [
  z.strictObject({
    approvalId: IdSchema,
    decision: z.literal("allow"),
    apps: ComputerAppIdListSchema,
    duration: ComputerGrantDurationSchema,
    foregroundAsk: z.boolean(),
    allowCoordinates: z.boolean(),
    // "don't ask again" adds the apps to the Bot's always-list (never coordinates).
    always: z.boolean().optional(),
  }),
  z.strictObject({ approvalId: IdSchema, decision: z.literal("deny") }),
]);
export const ComputerStepIdParamsSchema = z.strictObject({ stepId: IdSchema });
export type ComputerGrant = z.infer<typeof ComputerGrantSchema>;
export type ScopedComputerAlways = z.infer<typeof ScopedComputerAlwaysSchema>;
export type ComputerAlways = z.infer<typeof ComputerAlwaysSchema>;
export type ComputerBlocklistEntry = z.infer<typeof ComputerBlocklistEntrySchema>;
export type ComputerSettings = z.infer<typeof ComputerSettingsSchema>;
export type ComputerStep = z.infer<typeof ComputerStepSchema>;
export type ComputerStepMethod = z.infer<typeof ComputerStepMethodSchema>;
export type ComputerStepResult = z.infer<typeof ComputerStepResultSchema>;
export type ComputerStepAction = z.infer<typeof ComputerStepActionSchema>;
export type ComputerStepHandoff = z.infer<typeof ComputerStepHandoffSchema>;
export type ComputerStepPage = z.infer<typeof ComputerStepPageSchema>;
export type ComputerState = z.infer<typeof ComputerStateSchema>;
export type ComputerPermissions = z.infer<typeof ComputerPermissionsSchema>;
export type ComputerGrantResolve = z.infer<typeof ComputerGrantResolveSchema>;
export type ComputerInstalledApps = z.infer<typeof ComputerInstalledAppsSchema>;
