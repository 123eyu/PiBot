import { z } from "zod";

/** Private main/brain channel; never part of the renderer or phone method tables. */
export const RemoteHostMethods = {
  "host.remote.keepAwake": {
    params: z.strictObject({ enabled: z.boolean() }),
    result: z.enum(["off", "requested", "unsupported"]),
  },
} as const;
