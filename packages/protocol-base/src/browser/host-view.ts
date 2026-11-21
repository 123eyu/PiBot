import { z } from "zod";
import { base64Schema } from "../chat/attachments.ts";
import { IdSchema } from "../core/ids.ts";
import { DomainSchema } from "../permissions/settings.ts";
import { BROWSER_FRAME_MAX_BYTES, BrowserViewDisplaySchema } from "./browser.ts";
import { BrowserDebugViewHostMethods } from "./debug.ts";
import { HostBrowserInputEventSchema, HostBrowserTabIdSchema } from "./host.ts";

// brain → background host methods behind the overlay. Frames themselves never use this
// table: the host streams them to the window over the dedicated frame channel (`browser.ts`).
const bot = { botId: IdSchema, groupId: IdSchema.optional() };
const text = (max: number) => z.string().max(max);

export const HostBrowserViewTabSchema = z.strictObject({
  tab: HostBrowserTabIdSchema,
  url: text(8192),
  title: text(1000),
  /** The tab the overlay shows: the Bot's active tab unless the user picked another one. */
  active: z.boolean(),
  loading: z.boolean(),
  /** Chromium's error name when the page did not load (the tab then shows a blank error page). */
  error: z
    .string()
    .regex(/^ERR_[A-Z0-9_]{1,80}$/)
    .optional(),
  /** Remembered while the pages sleep (closed to save memory); reopened on next use. */
  sleeping: z.boolean().optional(),
});
export const HostBrowserViewSchema = z.strictObject({
  open: z.boolean(),
  tabs: z.array(HostBrowserViewTabSchema).max(16),
  takeover: z.boolean(),
  viewing: z.boolean(),
  recording: z.boolean(),
  /** No page is open, but `tabs` lists the sleeping ones to reopen. */
  sleeping: z.boolean().optional(),
  /**
   * Only on a hand-back result. Sites (hostnames only, never the account or anything
   * typed) where a login form was submitted during the takeover that just ended, by the same
   * detection that offers "save this account?".
   */
  signedIn: z.array(DomainSchema).min(1).max(3).optional(),
});
const view = HostBrowserViewSchema;
/**
 * The latest screencast frame for the phone (JPEG, base64 so it crosses JSON links).
 * Width / height are the page CSS pixels the frame covers, like the overlay's frame message.
 */
export const HostBrowserRemoteFrameSchema = z.strictObject({
  seq: z.number().int().positive().safe(),
  tab: HostBrowserTabIdSchema,
  width: z.number().int().min(1).max(8192),
  height: z.number().int().min(1).max(8192),
  data: base64Schema(BROWSER_FRAME_MAX_BYTES),
});
export const BrowserViewHostMethods = {
  ...BrowserDebugViewHostMethods,
  /** Never creates a browser session; an unknown Bot reports a closed browser. */
  "host.browser.view.state": { params: z.strictObject(bot), result: view },
  "host.browser.view.visible": {
    params: z.strictObject({
      ...bot,
      visible: z.boolean(),
      display: BrowserViewDisplaySchema.optional(),
    }),
    result: view,
  },
  "host.browser.view.takeover": {
    params: z.strictObject({
      ...bot,
      on: z.boolean(),
      /**
       * Shows a desktop takeover as a real window; a phone takeover keeps the page
       * hidden on the computer, so nothing jumps in front of whoever sits there. Absent = true.
       */
      window: z.boolean().optional(),
    }),
    result: view,
  },
  /**
   * Pulls the phone's next frame. Shares the overlay's screencast (never a second one),
   * returns at most one frame per BROWSER_REMOTE_FRAME_INTERVAL_MS and only frames newer than
   * `after`, waiting up to `waitMs` for one. Each call renews the phone viewer's lease; without
   * calls the host stops it on its own. Never opens a browser session.
   */
  "host.browser.view.remoteFrame": {
    params: z.strictObject({
      ...bot,
      after: z.number().int().nonnegative().safe(),
      waitMs: z.number().int().min(0).max(5000),
    }),
    result: z.strictObject({ view, frame: HostBrowserRemoteFrameSchema.nullable() }),
  },
  /** The phone left the view: stop its share of the screencast now instead of at lease expiry. */
  "host.browser.view.remoteStop": { params: z.strictObject(bot), result: z.null() },
  /** Reopen the sleeping tabs (needs rules pushed first, like any page). */
  "host.browser.view.wake": { params: z.strictObject(bot), result: view },
  /** A blank tab the user types an address into ("+" in the tab strip). */
  "host.browser.view.newTab": { params: z.strictObject(bot), result: view },
  /**
   * Only accepted during takeover. Input for a tab the overlay no longer shows (it closed, the
   * view moved on) is dropped without an error; it is never sent to another tab.
   */
  "host.browser.view.input": {
    params: z.strictObject({
      ...bot,
      tab: HostBrowserTabIdSchema,
      event: HostBrowserInputEventSchema,
    }),
    result: z.null(),
  },
  "host.browser.view.switchTab": {
    params: z.strictObject({ ...bot, tab: HostBrowserTabIdSchema }),
    result: view,
  },
  "host.browser.view.navigate": {
    params: z.strictObject({
      ...bot,
      tab: HostBrowserTabIdSchema,
      action: z.enum(["url", "back", "forward", "reload"]),
      url: z.string().min(1).max(8192).optional(),
    }),
    result: view,
  },
  /** The user closed this tab; refused (busy) for the last tab while recording. */
  "host.browser.view.closeTab": {
    params: z.strictObject({ ...bot, tab: HostBrowserTabIdSchema }),
    result: view,
  },
  /** Closes the Bot's pages, then clears its session partition. */
  "host.browser.clearData": { params: z.strictObject(bot), result: z.null() },
  "host.browser.clearGroupData": {
    params: z.strictObject({ groupId: IdSchema }),
    result: z.null(),
  },
} as const;
export type HostBrowserView = z.infer<typeof HostBrowserViewSchema>;
export type HostBrowserViewTab = z.infer<typeof HostBrowserViewTabSchema>;
export type HostBrowserRemoteFrame = z.infer<typeof HostBrowserRemoteFrameSchema>;
