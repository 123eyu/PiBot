import { z } from "zod";
import { ImageContentSchema } from "../chat/attachments.ts";
import { AbsolutePathSchema } from "../core/boundaries.ts";
import { IdSchema } from "../core/ids.ts";
import { ComputerAppIdSchema } from "./apps.ts";

// brain → background process (host) calls for operating the computer.
// Every operating call carries the run's grant token; the host keeps only the token's hash and
// rejects calls whose grant is unknown, expired, revoked or does not cover the app.
// Driver refusals are results, not RPC errors, so the model can be told why and what to do next.

const noParams = z.union([z.undefined(), z.strictObject({})]);
const count = z.number().int().nonnegative().safe();
const coordinate = z.number().finite().min(-100_000).max(100_000);
const label = z.string().trim().min(1).max(200);

/** 32 random bytes, base64url; issued by brain, registered with the host before use. */
export const ComputerGrantTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, "invalid_grant_token");

/** Bundle id (macOS), executable name (Windows) or desktop/app name (Linux) as the OS reports it. */
// One app identity across layers (blocklist, always-list, grants, driver): the stricter rule.

export const ComputerGrantAppSchema = z.strictObject({ id: ComputerAppIdSchema, name: label });

export const HostComputerGrantSchema = z.strictObject({
  token: ComputerGrantTokenSchema,
  botId: IdSchema,
  runId: IdSchema,
  apps: z.array(ComputerGrantAppSchema).min(1).max(50),
  expiresAt: z.iso.datetime(),
  allowCoordinates: z.boolean(),
  foregroundAsk: z.boolean(),
});

export const ComputerFailureCodeSchema = z.enum([
  "grant_invalid",
  "grant_expired",
  "app_not_granted",
  "app_blocked",
  "coordinates_not_allowed",
  "needs_foreground",
  "screen_locked",
  "secure_field",
  // The password-field scan ran out of budget, so a text target cannot be cleared.
  "secure_scan_incomplete",
  "stale_element",
  "stale_screenshot",
  "target_moved",
  "app_not_running",
  "window_not_found",
  "permission_missing",
  "unsupported",
  "timeout",
  "cancelled",
  "driver_error",
]);
export const ComputerFailureSchema = z.strictObject({
  ok: z.literal(false),
  code: ComputerFailureCodeSchema,
  /** Short machine-oriented hint for the model (never contains screen text or secrets). */
  detail: z.string().max(500).optional(),
  /**
   * Whether the input reached the app, and whether repeating the step is safe. A timeout
   * after sending looks exactly like a refusal otherwise, and repeating it can act twice
   * (e.g. pressing Send again). Optional for older hosts: absent means the model has to check.
   */
  disposition: z
    .strictObject({
      delivered: z.enum(["no", "yes", "unknown"]),
      retry: z.enum(["safe", "after_check", "unsafe"]),
    })
    .optional(),
  /**
   * The app's own menu titles at the level where a menu path stopped matching. They are
   * the granted app's UI labels (screen text): the model gets them marked untrusted, the host
   * audit line never logs them. Menus are not in the window tree, so this is how a wrong guess
   * ("Edit" in an app whose menus are in Chinese) finds the real title.
   */
  choices: z.array(z.string().max(100)).max(40).optional(),
  /** Granted, unblocked window labels; untrusted screen text, never host audit fields. */
  windows: z
    .array(z.strictObject({ id: z.string().max(200), title: z.string().max(200) }))
    .max(20)
    .optional(),
  /** Non-secure editable tokens from this window's latest tree; suggestions, not authority. */
  focusTargets: z.array(z.string().min(1).max(512)).max(8).optional(),
  /** A batch is never replayed after partial completion. */
  completed: z.number().int().min(0).max(10).optional(),
});
const outcome = <T extends z.ZodRawShape>(shape: T) =>
  z.discriminatedUnion("ok", [
    z.strictObject({ ok: z.literal(true), ...shape }),
    ComputerFailureSchema,
  ]);

/** An installed app for the user-editable blocklist; id compares case-insensitively. */
export const ComputerInstalledAppSchema = z.strictObject({
  id: ComputerAppIdSchema,
  name: label,
  iconPath: AbsolutePathSchema.optional(),
  /** Suggests a default tick in the blocklist. */
  category: z.enum(["chat", "mail"]).optional(),
});

export const HostComputerAppSchema = z.strictObject({
  id: ComputerAppIdSchema,
  name: label,
  pid: count,
  active: z.boolean(),
  /** Never operable or capturable, regardless of any grant. */
  blocked: z.boolean(),
});

export const ComputerRectSchema = z.strictObject({
  x: coordinate,
  y: coordinate,
  width: z.number().finite().nonnegative().max(100_000),
  height: z.number().finite().nonnegative().max(100_000),
});

export const ComputerElementSchema = z.strictObject({
  /** Opaque element token, valid until the window's next tree read. */
  id: z.string().min(1).max(512),
  role: z.string().max(100),
  name: z.string().max(500).optional(),
  /** Omitted for secure fields: their type is reported, their value never is. */
  value: z.string().max(500).optional(),
  secure: z.boolean().optional(),
  enabled: z.boolean().optional(),
  selected: z.boolean().optional(),
  actions: z.array(z.string().max(100)).max(30),
  /** Global logical points. */
  bounds: ComputerRectSchema.optional(),
  depth: count,
  parent: z.string().min(1).max(512).optional(),
});

export const ComputerTargetSchema = z.strictObject({
  token: ComputerGrantTokenSchema,
  app: ComputerAppIdSchema,
  /** Window id from a previous result, or a title fragment; default = the app's main window. */
  window: z.string().trim().min(1).max(200).optional(),
});

export const ComputerUiActionSchema = z.enum([
  "press",
  "setValue",
  "focus",
  "select",
  "scrollTo",
  "showMenu",
]);
/**
 * An app menu item by its titles as the app shows them, top-level menu first, e.g.
 * ["Edit", "Delete"] or ["编辑", "删除"]. At least two: a top-level title alone is a menu, not an
 * item, and pressing it would only open the menu.
 */
export const ComputerMenuPathSchema = z.array(z.string().trim().min(1).max(100)).min(2).max(8);
export const ComputerPointerKindSchema = z.enum([
  "click",
  "doubleClick",
  "rightClick",
  "drag",
  "move",
  "scroll",
]);
/** auto = background when the platform can, else needs_foreground; foreground = caller holds the lock. */
export const ComputerDeliverySchema = z.enum(["auto", "foreground"]);
const point = z.strictObject({ x: coordinate, y: coordinate });

export const ComputerPermissionStateSchema = z.enum([
  "granted",
  "denied",
  "not_determined",
  "ask_per_app",
  "not_needed",
  "unknown",
]);
export const ComputerStatusSchema = z.strictObject({
  platform: z.enum(["darwin", "win32", "linux"]),
  available: z.boolean(),
  /** Why the driver cannot run here (e.g. non-interactive Windows session); absent when available. */
  unavailableReason: z.string().max(200).optional(),
  permissions: z.strictObject({
    accessibility: ComputerPermissionStateSchema,
    screenRecording: ComputerPermissionStateSchema,
    automation: ComputerPermissionStateSchema,
  }),
  features: z.strictObject({
    backgroundClick: z.boolean(),
    backgroundDrag: z.boolean(),
    backgroundKeys: z.boolean(),
    displayScreenshot: z.boolean(),
  }),
});

export const ComputerOpenTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("app"), name: label }),
  z.strictObject({
    kind: z.literal("file"),
    path: AbsolutePathSchema,
    app: label.optional(),
  }),
]);

export const ComputerScreenshotSchema = z.strictObject({
  ok: z.literal(true),
  /** Pass back with pointer calls: coordinates are in this image's pixels. */
  screenshotId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  image: ImageContentSchema,
  width: count.positive(),
  height: count.positive(),
  scope: z.enum(["window", "display"]),
  /** Windows of blocked apps painted over (display screenshots only). */
  masked: count,
});

export const HostComputerMethods = {
  "host.computer.status": { params: noParams, result: ComputerStatusSchema },
  "host.computer.openSystemSettings": {
    params: z.strictObject({ pane: z.enum(["accessibility", "screenRecording", "automation"]) }),
    result: z.null(),
  },
  "host.computer.grants.set": { params: HostComputerGrantSchema, result: z.null() },
  "host.computer.grants.revoke": {
    params: z.union([
      z.strictObject({ token: ComputerGrantTokenSchema }),
      z.strictObject({ runId: IdSchema }),
      z.strictObject({ botId: IdSchema }),
    ]),
    result: z.strictObject({ revoked: count }),
  },
  /** Read-only OS alias lookup; this identity carries no grant or launch authority. */
  "host.computer.resolveAppName": {
    params: z.strictObject({ name: label }),
    result: z.strictObject({ id: ComputerAppIdSchema.nullable() }),
  },
  /** Installed apps (not a grant-scoped call: used by settings to build the blocklist). */
  "host.computer.installedApps": {
    params: z.strictObject({ limit: z.number().int().min(1).max(2000).optional() }),
    result: z.discriminatedUnion("supported", [
      z.strictObject({
        supported: z.literal(true),
        apps: z.array(ComputerInstalledAppSchema).max(2000),
        truncated: z.boolean(),
      }),
      z.strictObject({ supported: z.literal(false), reason: z.string().max(200) }),
    ]),
  },
  "host.computer.listApps": {
    params: z.strictObject({ token: ComputerGrantTokenSchema }),
    result: outcome({ apps: z.array(HostComputerAppSchema).max(500) }),
  },
  "host.computer.frontmostApp": {
    params: z.strictObject({ token: ComputerGrantTokenSchema }),
    result: outcome({ app: HostComputerAppSchema.nullable() }),
  },
  "host.computer.screenshot": {
    params: z.strictObject({
      token: ComputerGrantTokenSchema,
      /** Omit for a whole display (requires allowCoordinates). */
      app: ComputerAppIdSchema.optional(),
      window: z.string().trim().min(1).max(200).optional(),
      /** Display index from status order (0 = main) when no app is given. */
      display: count.max(16).optional(),
      /** Crop, in logical points relative to the window or display. */
      region: ComputerRectSchema.optional(),
      maxEdge: z.number().int().min(64).max(4096),
      maxBytes: z
        .number()
        .int()
        .min(16 * 1024)
        .max(5 * 1024 * 1024)
        .optional(),
    }),
    result: z.discriminatedUnion("ok", [ComputerScreenshotSchema, ComputerFailureSchema]),
  },
  "host.computer.uiTree": {
    params: ComputerTargetSchema.extend({
      depth: z.number().int().min(1).max(64).optional(),
      /** Case-insensitive text filter on role / name / value. */
      filter: z.string().trim().min(1).max(200).optional(),
      maxNodes: z.number().int().min(1).max(2000).optional(),
    }),
    result: outcome({
      window: z.strictObject({ id: z.string().max(64), title: z.string().max(500) }),
      elements: z.array(ComputerElementSchema).max(2000),
      truncated: z.boolean(),
      truncation: z
        .strictObject({
          reason: z.enum(["node_limit", "depth_limit", "driver"]),
          depthReached: count,
          remainingNodes: count.nullable(),
        })
        .optional(),
    }),
  },
  "host.computer.uiAction": {
    params: z.discriminatedUnion("action", [
      ComputerTargetSchema.extend({
        elementId: z.string().min(1).max(512),
        action: ComputerUiActionSchema,
        value: z.string().max(10_000).optional(),
      }),
      // Press an item of the app's menu bar by its path, through Accessibility. The
      // window names whose menu bar (the app's own); foreground = the user agreed.
      ComputerTargetSchema.extend({
        action: z.literal("menu"),
        path: ComputerMenuPathSchema,
        delivery: ComputerDeliverySchema.optional(),
      }),
      ComputerTargetSchema.extend({
        action: z.literal("batch"),
        actions: z
          .array(
            z.strictObject({
              elementId: z.string().min(1).max(512),
              action: ComputerUiActionSchema,
              value: z.string().max(10_000).optional(),
            }),
          )
          .min(1)
          .max(10),
      }),
    ]),
    result: outcome({
      effect: z.enum(["confirmed", "unverified"]),
      /** Menu actions only: where the item was pressed. */
      delivery: z.enum(["background", "foreground"]).optional(),
      /**
       * A side effect the step caused besides the action itself. "brought_window_to_front"
       * = select was done, but the platform's selection activated the app (a UWP / XAML tab was
       * pulled in front); the model must know instead of assuming an invisible background step.
       */
      note: z.enum(["brought_window_to_front"]).optional(),
      completed: z.number().int().min(0).max(10).optional(),
    }),
  },
  "host.computer.pointer": {
    params: ComputerTargetSchema.extend({
      screenshotId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
      kind: ComputerPointerKindSchema,
      x: coordinate,
      y: coordinate,
      to: point.optional(),
      dx: z.number().int().min(-50).max(50).optional(),
      dy: z.number().int().min(-50).max(50).optional(),
      delivery: ComputerDeliverySchema,
    }),
    result: outcome({ delivery: z.enum(["background", "foreground"]) }),
  },
  "host.computer.keys": {
    params: ComputerTargetSchema.extend({
      /** Type into this element; otherwise into the app's focused element. */
      elementId: z.string().min(1).max(512).optional(),
      text: z.string().min(1).max(10_000).optional(),
      /** e.g. ["cmd", "s"]; modifier names as in Cua (cmd/ctrl/alt/shift). */
      combo: z.array(z.string().min(1).max(20)).min(1).max(5).optional(),
      delivery: ComputerDeliverySchema,
    }),
    result: outcome({
      delivery: z.enum(["background", "foreground"]),
      /** Untrusted screen text: redact before sending to the model, never audit. */
      focusValue: z.string().max(2000).optional(),
    }),
  },
  // The host opens a granted app (or a file in it) with a fixed argv and no shell; the
  // model only names an app ID and a path, so this is not an agent command (rule 9).
  "host.computer.open": {
    params: z.strictObject({ token: ComputerGrantTokenSchema, target: ComputerOpenTargetSchema }),
    result: outcome({ app: ComputerGrantAppSchema.optional() }),
  },
  "host.computer.userActivity": {
    params: z.strictObject({ token: ComputerGrantTokenSchema }),
    result: outcome({ idleSeconds: z.number().nonnegative(), locked: z.boolean() }),
  },
} as const;

export type HostComputerGrant = z.infer<typeof HostComputerGrantSchema>;
export type ComputerFailureCode = z.infer<typeof ComputerFailureCodeSchema>;
export type ComputerFailure = z.infer<typeof ComputerFailureSchema>;
export type ComputerFailureDisposition = NonNullable<ComputerFailure["disposition"]>;
export type HostComputerApp = z.infer<typeof HostComputerAppSchema>;
export type ComputerInstalledApp = z.infer<typeof ComputerInstalledAppSchema>;
export type ComputerElement = z.infer<typeof ComputerElementSchema>;
export type ComputerRect = z.infer<typeof ComputerRectSchema>;
export type ComputerStatus = z.infer<typeof ComputerStatusSchema>;
export type ComputerOpenTarget = z.infer<typeof ComputerOpenTargetSchema>;
export type ComputerUiAction = z.infer<typeof ComputerUiActionSchema>;
export type ComputerMenuPath = z.infer<typeof ComputerMenuPathSchema>;
export type ComputerPointerKind = z.infer<typeof ComputerPointerKindSchema>;
export type ComputerDelivery = z.infer<typeof ComputerDeliverySchema>;
export type HostComputerMethod = keyof typeof HostComputerMethods;
export type HostComputerParams = {
  [K in HostComputerMethod]: z.input<(typeof HostComputerMethods)[K]["params"]>;
};
export type HostComputerResults = {
  [K in HostComputerMethod]: z.output<(typeof HostComputerMethods)[K]["result"]>;
};
