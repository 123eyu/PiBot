import {
  BROWSER_FRAME_MAX_BYTES,
  BrowserStateSchema,
  BrowserTabIdSchema,
  base64Schema,
  IdSchema,
  plainText,
} from "@pibot/protocol-base";
import { z } from "zod";

// The phone watches and drives the computer's Bot browser; it never opens pages itself.
// Served only by the authenticated phone gateway (no desktop handler), like `devices.self`.
const target = { botId: IdSchema, groupId: IdSchema.optional() };
const seq = z.number().int().nonnegative().safe();
/** Where on the frame, as a fraction of its width / height; the computer maps it to the page. */
const fraction = z.number().min(0).max(1);
const ok = z.strictObject({ ok: z.literal(true) });

export const RemoteBrowserFrameSchema = z.strictObject({
  seq: seq.positive(),
  tabId: BrowserTabIdSchema,
  width: z.number().int().min(1).max(8192),
  height: z.number().int().min(1).max(8192),
  data: base64Schema(BROWSER_FRAME_MAX_BYTES),
});
/**
 * Phone takeover input. Points refer to a frame the phone was sent (`seq`); keys are the few a
 * phone keyboard cannot type as text. Typed text is inserted as-is and never logged or audited.
 */
export const RemoteBrowserInputSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("tap"), x: fraction, y: fraction }),
  z.strictObject({
    type: z.literal("scroll"),
    x: fraction,
    y: fraction,
    deltaX: z.number().min(-5000).max(5000),
    deltaY: z.number().min(-5000).max(5000),
  }),
  z.strictObject({ type: z.literal("text"), text: z.string().min(1).max(1000) }),
  z.strictObject({
    type: z.literal("key"),
    key: z.enum([
      "Enter",
      "Backspace",
      "Tab",
      "Escape",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
    ]),
  }),
]);
export const RemoteBrowserMethods = {
  /**
   * Pull-based stream: the next frame newer than `after`, at most 2 per second. The next call is
   * the acknowledgement, so a slow relay slows the stream instead of queueing frames.
   */
  "remote.browser.frame": {
    params: z.strictObject({ ...target, after: seq }),
    result: z.strictObject({
      state: BrowserStateSchema,
      frame: RemoteBrowserFrameSchema.nullable(),
      /** This phone holds the takeover (not the desktop user or another phone). */
      mine: z.boolean(),
    }),
  },
  /** The phone left the browser view; a takeover it holds is handed back. */
  "remote.browser.stop": { params: z.strictObject(target), result: ok },
  "remote.browser.takeover": {
    params: z.strictObject({ ...target, on: z.boolean(), conversationId: IdSchema.optional() }),
    result: BrowserStateSchema,
  },
  "remote.browser.input": {
    params: z.strictObject({
      ...target,
      tabId: BrowserTabIdSchema,
      seq: seq.positive(),
      event: RemoteBrowserInputSchema,
    }),
    result: ok,
  },
  "remote.browser.navigate": {
    params: z.strictObject({
      ...target,
      tabId: BrowserTabIdSchema,
      action: z.enum(["url", "back", "forward", "reload"]),
      url: z.string().min(1).max(2048).refine(plainText).optional(),
    }),
    result: BrowserStateSchema,
  },
} as const;
export type RemoteBrowserInput = z.infer<typeof RemoteBrowserInputSchema>;
export type RemoteBrowserFrame = z.infer<typeof RemoteBrowserFrameSchema>;
