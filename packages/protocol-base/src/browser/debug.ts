import { z } from "zod";
import { IdSchema } from "../core/ids.ts";
import { BrowserNetworkSchema } from "./network.ts";

const seq = z.number().int().nonnegative().safe();
const tab = z.string().regex(/^t[1-9][0-9]{0,5}$/);
export const BrowserViewportSchema = z.strictObject({
  width: z.number().int().min(320).max(2560),
  height: z.number().int().min(240).max(1600),
  deviceScaleFactor: z.number().min(1).max(2).default(1),
  mobile: z.boolean().default(false),
});
export type BrowserViewport = z.infer<typeof BrowserViewportSchema>;
export const BrowserDiagnosticSchema = z.strictObject({
  seq,
  kind: z.enum(["console", "exception", "network"]),
  level: z.enum(["warning", "error"]),
  text: z.string().max(1024),
  url: z.string().max(1024).optional(),
  status: z.number().int().optional(),
});
export const BrowserDiagnosticsSchema = z.strictObject({
  network: BrowserNetworkSchema.optional(),
  documentId: IdSchema,
  supported: z.boolean(),
  oldestSeq: seq,
  nextSeq: seq,
  dropped: z.boolean(),
  entries: z.array(BrowserDiagnosticSchema).max(50),
});
export type BrowserDiagnostics = z.infer<typeof BrowserDiagnosticsSchema>;
export const BrowserElementSummarySchema = z.strictObject({
  documentId: IdSchema,
  ref: z.string().regex(/^e[1-9][0-9]{0,6}$/),
  tag: z.string().max(64),
  name: z.string().max(200).optional(),
  secret: z.boolean(),
  frameSupported: z.boolean(),
  bounds: z
    .strictObject({
      x: z.number().finite(),
      y: z.number().finite(),
      width: z.number().nonnegative().finite(),
      height: z.number().nonnegative().finite(),
    })
    .nullable(),
  styles: z.array(z.strictObject({ name: z.string().max(64), value: z.string().max(200) })).max(40),
});
export type BrowserElementSummary = z.infer<typeof BrowserElementSummarySchema>;
const query = { after: seq.optional(), limit: z.number().int().min(1).max(50).optional() };
const point = {
  tab,
  documentId: IdSchema,
  frameSeq: seq,
  x: z.number().int().min(0).max(16384),
  y: z.number().int().min(0).max(16384),
};
const bot = { botId: IdSchema, groupId: IdSchema.optional() };
const run = { ...bot, runId: IdSchema.optional() };
export const BrowserDebugHostMethods = {
  "host.browser.diagnostics": {
    params: z.strictObject({ ...run, tab: tab.optional(), ...query }),
    result: BrowserDiagnosticsSchema,
  },
  "host.browser.inspect": {
    params: z.strictObject({
      ...run,
      tab: tab.optional(),
      ref: z.string().regex(/^e[1-9][0-9]{0,6}$/),
      documentId: IdSchema.optional(),
    }),
    result: BrowserElementSummarySchema,
  },
} as const;
export const BrowserDebugViewHostMethods = {
  "host.browser.view.debug": {
    params: z.strictObject({ ...bot, tab: tab.optional(), ...query }),
    result: BrowserDiagnosticsSchema,
  },
  "host.browser.view.inspectPoint": {
    params: z.strictObject({ ...bot, ...point }),
    result: BrowserElementSummarySchema,
  },
} as const;
