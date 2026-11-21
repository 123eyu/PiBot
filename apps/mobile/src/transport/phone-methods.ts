import { Methods } from "@pibot/protocol";
import { z } from "zod";

/**
 * The phone's application method table: the desktop's, plus the request-only local-unlock mark
 * the desktop phone gateway accepts on a permission widening ( * packages/remote/src/brain/rpc/settings-gate.ts). Only features/settings/calls.ts sets it, after
 * the phone was unlocked for that very change.
 */
const permissionsSet = {
  ...Methods["permissions.set"],
  params: Methods["permissions.set"].params.safeExtend({
    phoneUnlock: z.literal(true).optional(),
  }),
};
// Refer to the shared table instead of serializing every expanded Zod method into this .d.ts.
export const PhoneMethods: Omit<typeof Methods, "permissions.set"> & {
  "permissions.set": typeof permissionsSet;
} = {
  ...Methods,
  "permissions.set": permissionsSet,
};
