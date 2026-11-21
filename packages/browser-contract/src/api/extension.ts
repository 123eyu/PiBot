import type { Params, Result } from "@pibot/protocol-base";
import { BrowserHostMethods, IdSchema } from "@pibot/protocol-base";
import { z } from "zod";

const extensionMethodNames = [
  "open",
  "snapshot",
  "click",
  "type",
  "select",
  "upload",
  "scroll",
  "back",
  "tabs",
  "close",
  "screenshot",
  "wait",
] as const;
const extensionRequestNames = [...extensionMethodNames, "inspect", "stop"] as const;
export type ExtensionMethodName = (typeof extensionMethodNames)[number] | "inspect";
const hostMethod = (name: (typeof extensionMethodNames)[number]) =>
  BrowserHostMethods[`host.browser.${name}` as keyof typeof BrowserHostMethods];
type HostShaped = {
  [K in Exclude<ExtensionMethodName, "open">]: (typeof BrowserHostMethods)[`host.browser.${K}`];
};
const extensionMethods = {
  ...(Object.fromEntries(
    extensionMethodNames.map((name) => [name, hostMethod(name)]),
  ) as unknown as HostShaped),
  // The extension also names the Bot's tab group, so open carries the Bot's display name.
  open: {
    params: z.strictObject({
      botId: IdSchema,
      groupId: IdSchema.optional(),
      // Every host.browser call carries the run; without it here every open was refused.
      runId: IdSchema.optional(),
      url: z.string().min(1).max(8192),
      newTab: z.boolean().optional(),
      botName: z.string().min(1).max(200).optional(),
    }),
    result: hostMethod("open").result,
  },
  /**
   * What a click on (or Enter in) `ref` would do, so the host applies the site and submit
   * approvals before acting in the user's own browser: the link it follows, the form it submits.
   */
  inspect: {
    params: z.strictObject({
      botId: IdSchema,
      ref: z.string().regex(/^e[1-9][0-9]{0,6}$/),
      tab: z.string().optional(),
    }),
    result: z.strictObject({
      href: z.string().max(8192).nullable(),
      submits: z.boolean(),
      formAction: z.string().max(8192).nullable(),
      pageUrl: z.string().max(8192),
    }),
  },
};
export const ExtensionRequestSchema = z.strictObject({
  id: z.string().min(1).max(128),
  method: z.enum(extensionRequestNames),
  params: z.unknown(),
});
export const ExtensionResponseSchema = z
  .strictObject({
    id: z.string().min(1).max(128),
    result: z.unknown().optional(),
    error: z.strictObject({ code: z.string().max(64), message: z.string().max(1000) }).optional(),
  })
  .refine(
    (value) => (value.result === undefined) !== (value.error === undefined),
    "result or error is required",
  );
export const ExtensionEventSchema = z.strictObject({
  event: z.enum(["hello", "stop"]),
  payload: z.unknown(),
});
export const ExtensionHelloSchema = z.strictObject({
  version: z.string().min(1).max(32),
  browser: z.enum(["chrome", "edge", "firefox", "chromium"]),
});
export const ExtensionStopSchema = z.strictObject({
  botId: z.string().min(1),
  tab: z.string().optional(),
});
export const ExtensionMethods = extensionMethods;
export type ExtensionMethodParams = {
  [K in ExtensionMethodName]: Params<typeof ExtensionMethods, K>;
};
export type ExtensionMethodResults = {
  [K in ExtensionMethodName]: Result<typeof ExtensionMethods, K>;
};
export function parseExtensionParams<K extends ExtensionMethodName>(
  method: K,
  params: unknown,
): ExtensionMethodParams[K] {
  return ExtensionMethods[method].params.parse(params) as ExtensionMethodParams[K];
}
