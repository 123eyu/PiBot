import { z } from "zod";

/** Public bounded diagnostics only. No host config, credential paths or executable capability. */
export const HostSshFactsSchema = z.strictObject({
  version: z.literal(1),
  status: z.enum(["unsupported", "candidate"]),
  reason: z.enum([
    "confirmation_required",
    "not_enabled",
    "identity_required",
    "unsupported_syntax",
    "unsupported_target",
    "configuration_unavailable",
    "unsupported_configuration",
    "configuration_limit",
    "configuration_changed",
  ]),
  alias: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
    .optional(),
  /**
   * Which part of the configuration was refused, so the model can tell the person what to
   * fix instead of listing ProxyJump / Match for every cause. Only keywords and bounded names.
   */
  configDetail: z
    .enum([
      "proxy",
      "match",
      "include_outside_home",
      "include_in_workspace",
      "strict_host_key",
      "option",
      "user",
      "identity_outside_ssh",
      "other",
    ])
    .optional(),
  configOption: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/)
    .optional(),
  hostname: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/)
    .optional(),
  port: z.number().int().min(1).max(65535).optional(),
  intentDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  resourceVersion: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  dependencyCount: z.number().int().min(1).max(40).optional(),
  authority: z.literal("none"),
});
export type HostSshFacts = z.infer<typeof HostSshFactsSchema>;
