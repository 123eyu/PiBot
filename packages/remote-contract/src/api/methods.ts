import { CapabilityManifestSchema, EndpointSessionEvents, IdSchema } from "@pibot/protocol-base";
import { z } from "zod";
import { RemoteBrowserMethods } from "./browser.ts";
import { defaultRemoteDirect, RemoteDirectSchema } from "./direct.ts";
import {
  DeviceNameSchema,
  DeviceViewSchema,
  InteractiveClientSchema,
  PairStatusSchema,
  RemoteSessionUpdateSchema,
  RemoteSettingsSchema,
  RemoteStateSchema,
} from "./entities.ts";
import { OfflineEvents, OfflineMethods } from "./offline.ts";
import {
  PhoneDataStateSchema,
  RemoteShareReceiptSchema,
  RemoteShareUploadSchema,
} from "./phone-data.ts";
import { RemotePreviewChunkSchema, RemotePreviewReadSchema } from "./preview.ts";
import { RunnerControlMethods } from "./runner-control.ts";

const empty = z.union([z.undefined(), z.strictObject({})]);
const id = z.strictObject({ id: IdSchema });
const ok = z.strictObject({ ok: z.literal(true) });
export const RemoteMethods = {
  "remote.settings.get": { params: empty, result: RemoteSettingsSchema },
  "remote.settings.set": {
    params: z.strictObject({
      expectedVersion: z.number().int().nonnegative().safe(),
      // Partial updates must not materialize defaults: neither saved STUN consent nor a disabled
      // LAN discovery may be silently reset by an update that omits them.
      patch: RemoteSettingsSchema.omit({ version: true }).partial().extend({
        direct: RemoteDirectSchema.optional(),
        lanDiscovery: z.boolean().optional(),
      }),
      disclosureAccepted: z.literal(true).optional(),
    }),
    result: RemoteSettingsSchema,
  },
  "remote.status": { params: empty, result: RemoteStateSchema },
  "devices.pairStart": {
    // The brain retries the pairing room for up to 60 s on slow networks before failing.
    timeoutMs: 65_000,
    params: z.union([empty, z.strictObject({ kind: z.literal("runner") })]),
    result: z.strictObject({
      id: IdSchema,
      payload: z.string().min(1).max(8192),
      expiresAt: z.iso.datetime(),
    }),
  },
  "devices.runnerPair": {
    params: z.strictObject({ code: z.string().min(25).max(1152) }),
    result: ok,
  },
  "devices.pairStatus": { params: id, result: PairStatusSchema },
  "devices.pairCancel": { params: id, result: ok },
  "devices.endpoints": {
    params: z.strictObject({
      after: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(10).default(10),
    }),
    result: z.strictObject({
      items: z
        .array(
          z.strictObject({
            id: z.union([IdSchema, z.literal("local")]),
            name: DeviceNameSchema,
            kind: z.enum(["desktop", "phone", "runner"]),
            target: z
              .string()
              .regex(/^runner:[a-f0-9]{64}$/)
              .optional(),
            platform: z.enum(["darwin", "linux", "win32", "android", "ios"]).optional(),
            online: z.boolean(),
            path: z.enum(["lan", "address", "punched", "relay", "direct"]).optional(),
          }),
        )
        .max(10),
      nextAfter: z.string().nullable(),
    }),
  },
  "devices.list": {
    params: z.strictObject({
      after: IdSchema.optional(),
      limit: z.number().int().min(1).max(100).optional(),
      includeRevoked: z.boolean().optional(),
      includeRevocationPending: z.boolean().optional(),
    }),
    result: z.strictObject({
      items: z.array(DeviceViewSchema).max(100),
      nextAfter: IdSchema.nullable(),
    }),
  },
  "devices.rename": { params: id.extend({ name: DeviceNameSchema }), result: DeviceViewSchema },
  // The user's answer to a Bot's "move this topic to a runner folder" card.
  "remote.workplaceMove.resolve": {
    params: z.strictObject({ noticeId: IdSchema, accept: z.boolean() }),
    result: ok,
  },
  "devices.revoke": { params: id.extend({ removeAnyway: z.literal(true).optional() }), result: ok },
  "devices.self": {
    params: empty,
    result: z.strictObject({
      desktopId: IdSchema,
      desktopName: DeviceNameSchema,
      deviceId: IdSchema,
      deviceName: DeviceNameSchema,
      endpointCapabilities: z.literal(1).optional(),
      // Phone-link keepalive (link.keepalive on every path); older phones strip it unread.
      linkKeepalive: z.literal(1).optional(),
      // This phone's event stream on this desktop: one per paired phone and brain lifetime, so a
      // phone that reconnects resumes from its last sequence instead of reloading every screen.
      // `seq` is the stream's last sequence when this answer was made. Older phones strip it.
      eventStream: z
        .strictObject({
          id: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
          seq: z.number().int().nonnegative().safe(),
        })
        .optional(),
      direct: RemoteDirectSchema.default(defaultRemoteDirect),
      lanAddresses: z.array(z.string().max(256)).max(8).default([]),
      interactive: InteractiveClientSchema.optional(),
    }),
  },
  // These are authenticated phone-session metadata, never a renderer-selected device identity.
  "remote.session.update": { params: RemoteSessionUpdateSchema, result: ok },
  // Phone sessions only: preview.read in frame-sized slices (the desktop gateway answers it).
  "remote.preview.read": { params: RemotePreviewReadSchema, result: RemotePreviewChunkSchema },
  ...RemoteBrowserMethods,
  // Phone sessions only: one shared file in frame-sized slices, kept for this session.
  "remote.share.upload": { params: RemoteShareUploadSchema, result: RemoteShareReceiptSchema },
  // Phone sessions only: which data switches the phone has on for this computer.
  "remote.phoneData.state": {
    params: PhoneDataStateSchema.extend({
      manifest: CapabilityManifestSchema.optional(),
      acceptedRevision: z.number().int().positive().safe().optional(),
    }),
    result: ok.extend({
      enabled: EndpointSessionEvents["endpoint.enabled"]
        .extend({ revision: z.number().int().positive().safe() })
        .optional(),
    }),
  },
  // Offline sync source and import (phone sessions) and its settings (desktop renderer).
  ...OfflineMethods,
  ...RunnerControlMethods,
} as const;
export const RemoteEvents = {
  "devices.changed": z.strictObject({}),
  "remote.state": RemoteStateSchema,
  "remote.interactive": z.strictObject({ interactive: InteractiveClientSchema }),
  ...OfflineEvents,
} as const;
