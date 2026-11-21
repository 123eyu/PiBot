import {
  BrowserDiagnosticsSchema,
  BrowserElementSummarySchema,
  BrowserInputEventSchema,
  BrowserStateSchema,
  BrowserTabIdSchema,
  BrowserViewDisplaySchema,
  IdSchema,
  plainText,
} from "@pibot/protocol-base";
import { z } from "zod";

const ok = z.strictObject({ ok: z.literal(true) });
const botId = z.strictObject({ botId: IdSchema, groupId: IdSchema.optional() });
const seq = z.number().int().nonnegative().safe();
const tab = z.string().regex(/^t[1-9][0-9]{0,5}$/);
const bot = { botId: IdSchema, groupId: IdSchema.optional() };
const query = { after: seq.optional(), limit: z.number().int().min(1).max(50).optional() };
const point = { x: z.number().int().min(0).max(16384), y: z.number().int().min(0).max(16384) };
export const BrowserMethods = {
  // Starts or stops the frame stream for the overlay; frames use the dedicated port below.
  "browser.view": {
    params: botId.extend({ visible: z.boolean(), display: BrowserViewDisplaySchema.optional() }),
    result: BrowserStateSchema,
  },
  "browser.takeover": {
    params: botId.extend({
      on: z.boolean(),
      // Where the user took over (DM topic or group conversation): the hand-back record goes there.
      conversationId: IdSchema.optional(),
    }),
    result: BrowserStateSchema,
  },
  "browser.input": {
    params: botId.extend({ tabId: BrowserTabIdSchema, event: BrowserInputEventSchema }),
    result: ok,
  },
  "browser.tabs": { params: botId, result: BrowserStateSchema },
  "browser.switchTab": {
    params: botId.extend({ tabId: BrowserTabIdSchema }),
    result: BrowserStateSchema,
  },
  // The address bar, back, forward and reload, at any time. The user's own
  // address is not asked about, but private addresses and the only-listed mode still apply; while
  // the Bot acts on that tab a typed address opens in a new tab.
  "browser.navigate": {
    params: botId.extend({
      tabId: BrowserTabIdSchema,
      action: z.enum(["url", "back", "forward", "reload"]),
      url: z.string().min(1).max(2048).refine(plainText).optional(),
    }),
    result: BrowserStateSchema,
  },
  // Wipes this Bot's browser profile (cookies, storage, cache, sign-ins). Open pages close
  // first; refused with busy while the user has taken over or a recording runs.
  "browser.clearData": {
    params: z.union([z.strictObject({ botId: IdSchema }), z.strictObject({ groupId: IdSchema })]),
    result: z.union([BrowserStateSchema, ok]),
  },
  // The user closes one tab from the tab strip at any time (no takeover needed). A Bot
  // action on that tab fails with "the user closed the tab"; closing the last tab closes the
  // Bot's pages. While teaching (recording) the last tab cannot be closed.
  // Reopen the sleeping tabs (the sleeping view was clicked).
  "browser.wake": { params: botId, result: BrowserStateSchema },
  // "+" in the tab strip, a blank tab for the user's own address.
  "browser.newTab": { params: botId, result: BrowserStateSchema },
  "browser.closeTab": {
    params: botId.extend({ tabId: BrowserTabIdSchema }),
    result: BrowserStateSchema,
  },
} as const;
export const BrowserEvents = {
  "browser.state": BrowserStateSchema,
} as const;

export const BrowserDebugMethods = {
  "browser.debug": {
    params: z.strictObject({ ...bot, conversationId: IdSchema, tabId: tab.optional(), ...query }),
    result: BrowserDiagnosticsSchema,
  },
  "browser.inspectPoint": {
    params: z.strictObject({
      ...bot,
      conversationId: IdSchema,
      tabId: tab,
      documentId: IdSchema,
      frameSeq: seq,
      x: point.x,
      y: point.y,
    }),
    result: BrowserElementSummarySchema,
  },
} as const;
