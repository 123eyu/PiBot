import {
  ComputerAlwaysSchema,
  ComputerAlwaysScopeSchema,
  ComputerAppIdSchema,
  ComputerAppSchema,
  ComputerBlocklistEntrySchema,
  ComputerGrantResolveSchema,
  ComputerGrantSchema,
  ComputerInstalledAppsSchema,
  ComputerPermissionKindSchema,
  ComputerPermissionsSchema,
  ComputerSettingsSchema,
  ComputerStateSchema,
  ComputerStepIdParamsSchema,
  ComputerStepSchema,
  IdSchema,
  ImageContentSchema,
  PageSchema,
  ScopedComputerAlwaysSchema,
  ThumbnailContentSchema,
} from "@pibot/protocol-base";
import { z } from "zod";

const ok = z.strictObject({ ok: z.literal(true) });
const noParams = z.union([z.undefined(), z.strictObject({})]);
const botId = z.strictObject({ botId: IdSchema });
export const ComputerMethods = {
  "computer.grant.resolve": {
    params: ComputerGrantResolveSchema,
    result: z.strictObject({ ok: z.literal(true), grant: ComputerGrantSchema.nullable() }),
  },
  "computer.grants": {
    params: PageSchema.extend({
      botId: IdSchema.optional(),
      runId: IdSchema.optional(),
      groupId: IdSchema.optional(),
    }),
    result: z.array(ComputerGrantSchema).max(200),
  },
  // Stops the Bot's current run and revokes the run's grant; the always-list is untouched.
  "computer.stop": { params: botId, result: ok },
  "computer.pause": { params: botId, result: ok },
  "computer.resume": { params: botId, result: ok },
  // The user's answer on a "come help for a moment" card (chat or inbox).
  "computer.handoff.resolve": {
    params: z.strictObject({ id: IdSchema, action: z.enum(["continue", "decline"]) }),
    result: ok,
  },
  "computer.foreground.resolve": {
    params: z.strictObject({ requestId: IdSchema, allow: z.boolean() }),
    result: ok,
  },
  // Snapshot for reconnecting windows; later changes arrive as `computer.state` events.
  "computer.status": { params: noParams, result: z.array(ComputerStateSchema).max(200) },
  "computer.permissions": { params: noParams, result: ComputerPermissionsSchema },
  "computer.openSystemSettings": {
    params: z.strictObject({ pane: ComputerPermissionKindSchema }),
    result: ok,
  },
  "computer.always.get": {
    params: ComputerAlwaysScopeSchema,
    result: ScopedComputerAlwaysSchema.nullable(),
  },
  "computer.always.set": {
    params: z.union([
      botId.extend({ groupId: z.never().optional(), apps: ComputerAlwaysSchema.shape.apps }),
      z.strictObject({
        groupId: IdSchema,
        botId: z.never().optional(),
        apps: ComputerAlwaysSchema.shape.apps,
      }),
    ]),
    result: ScopedComputerAlwaysSchema,
  },
  "computer.always.clear": { params: ComputerAlwaysScopeSchema, result: ok },
  "computer.blocklist.list": {
    params: noParams,
    result: z.array(ComputerBlocklistEntrySchema).max(500),
  },
  "computer.blocklist.add": {
    params: z.strictObject({ app: ComputerAppSchema }),
    result: ComputerBlocklistEntrySchema,
  },
  "computer.blocklist.remove": {
    params: z.strictObject({ appId: ComputerAppIdSchema }),
    result: ok,
  },
  "computer.settings.get": { params: noParams, result: ComputerSettingsSchema },
  "computer.settings.set": { params: ComputerSettingsSchema, result: ComputerSettingsSchema },
  "computer.steps": {
    params: PageSchema.extend({
      from: z.iso.datetime().optional(),
      botId: IdSchema.optional(),
      runId: IdSchema.optional(),
      groupId: IdSchema.optional(),
    }),
    result: z.array(ComputerStepSchema).max(200),
  },
  "computer.screenshot.thumbnail": {
    params: ComputerStepIdParamsSchema,
    result: ThumbnailContentSchema,
  },
  // "Click to see larger": bounded by the attachment image limit, fetched one at a time.
  "computer.screenshot.view": { params: ComputerStepIdParamsSchema, result: ImageContentSchema },
  // Apps installed on this computer for the blocklist, always-list and routine pickers.
  // brain forwards `host.computer.installedApps` without icon paths (the renderer cannot read files).
  "computer.installedApps": { params: noParams, result: ComputerInstalledAppsSchema },
} as const;
export const ComputerEvents = {
  "computer.step": z.strictObject({ step: ComputerStepSchema }),
  "computer.state": ComputerStateSchema,
} as const;
