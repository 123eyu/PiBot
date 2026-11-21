import { z } from "zod";

const Localized = z.strictObject({ zh: z.string().max(2000), en: z.string().max(2000) });
const Avatar = z.strictObject({
  shape: z.string().max(40),
  color: z.string().max(40),
  eyes: z.string().max(40),
});
export const RoleCatalogItemSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  version: z.number().int().positive(),
  name: Localized,
  description: Localized,
  category: z.string().max(80),
  archive: z.string().regex(/^(roles|groups)\/[a-z0-9][a-z0-9-]*\.v[1-9][0-9]*\.pibot$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive(),
  minApp: z.string().max(50).optional(),
  title: Localized.optional(),
  summary: Localized.optional(),
  avatar: Avatar.optional(),
  defaultBotName: Localized.optional(),
  members: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/))
    .max(12)
    .optional(),
});
export const RoleCatalogSchema = z.strictObject({
  format: z.literal(1),
  generatedAt: z.string().datetime(),
  minApp: z.string().max(50),
  roles: z.array(RoleCatalogItemSchema),
  groups: z.array(RoleCatalogItemSchema),
  history: z.record(z.string(), z.unknown()),
  professions: z.array(z.unknown()).optional(),
});
export type RoleCatalog = z.infer<typeof RoleCatalogSchema>;
export type RoleCatalogItem = z.infer<typeof RoleCatalogItemSchema>;

// Production trust list: the release key's private half stays off the
// repository on the release machine; a catalog signed by anything else is refused.
export const ROLE_CATALOG_PUBLIC_KEYS: readonly string[] = [
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAckoPte/dxZaEH/1NuCjIgfwZhlL0PK/Ec2LCiiUyyAI=\n-----END PUBLIC KEY-----\n",
];

/** What a role or group template looks like to the app: the catalog entry plus local state. */
export const RoleCatalogEntrySchema = z.strictObject({
  kind: z.enum(["role", "group"]),
  id: RoleCatalogItemSchema.shape.id,
  version: RoleCatalogItemSchema.shape.version,
  name: Localized,
  description: Localized,
  title: RoleCatalogItemSchema.shape.title,
  summary: RoleCatalogItemSchema.shape.summary,
  avatar: RoleCatalogItemSchema.shape.avatar,
  defaultBotName: RoleCatalogItemSchema.shape.defaultBotName,
  members: RoleCatalogItemSchema.shape.members,
  category: RoleCatalogItemSchema.shape.category,
  bytes: RoleCatalogItemSchema.shape.bytes,
  /** The version shipped inside this installer, if any. */
  bundled: z.number().int().positive().nullable(),
  /** The version downloaded from the catalog, if any. */
  installed: z.number().int().positive().nullable(),
  /** The catalog needs a newer app for this entry. */
  needsUpdate: z.boolean(),
});
export const RoleCatalogStateSchema = z.strictObject({
  /**
   * never: not checked yet; ready: a verified catalog is cached; untrusted: this build has no
   * release key, so nothing can be verified; unavailable: the last check failed (see `error`).
   */
  status: z.enum(["never", "ready", "untrusted", "unavailable"]),
  checkedAt: z.string().datetime().nullable(),
  error: z
    .enum(["offline", "server", "signature", "format", "too_large", "app_too_old"])
    .nullable(),
  entries: z.array(RoleCatalogEntrySchema).max(1000),
});
export type RoleCatalogEntry = z.infer<typeof RoleCatalogEntrySchema>;
export type RoleCatalogState = z.infer<typeof RoleCatalogStateSchema>;
const empty = z.union([z.undefined(), z.strictObject({})]);
export const RoleCatalogMethods = {
  /** The cached catalog and what is bundled / installed; reads nothing from the network. */
  "roleCatalog.get": { params: empty, result: RoleCatalogStateSchema },
  /** Downloads and verifies the catalog (the user asked; nothing checks on its own). */
  "roleCatalog.check": { params: empty, result: RoleCatalogStateSchema },
  /** Downloads one role or group template from the verified catalog and makes it available. */
  "roleCatalog.install": {
    params: z.strictObject({ kind: z.enum(["role", "group"]), id: RoleCatalogItemSchema.shape.id }),
    result: z.strictObject({ ok: z.literal(true), version: z.number().int().positive() }),
  },
} as const;
