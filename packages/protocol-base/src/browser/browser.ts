import { z } from "zod";
import { plainText } from "../computer/apps.ts";
import { IdSchema } from "../core/ids.ts";

const time = z.iso.datetime();
const count = z.number().int().nonnegative().safe();

/** CDP target IDs are opaque tokens; the shape keeps them out of paths and markup. */
export const BrowserTabIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const BrowserTabSchema = z.strictObject({
  id: BrowserTabIdSchema,
  // Display only (read-only address bar); navigation always goes through the Bot's policy-gated tools.
  url: z.string().max(2048).refine(plainText),
  title: z.string().max(500).refine(plainText),
  active: z.boolean(),
  loading: z.boolean(),
  /** Chromium's error name when the page did not load; the pane offers a reload instead. */
  error: z
    .string()
    .regex(/^ERR_[A-Z0-9_]{1,80}$/)
    .optional(),
  /** A sleeping tab (pages closed to save memory), reopened on the next use. */
  sleeping: z.boolean().optional(),
});
export const BrowserStateSchema = z.strictObject({
  botId: IdSchema,
  groupId: IdSchema.optional(),
  open: z.boolean(),
  tabs: z.array(BrowserTabSchema).max(50),
  // While taken over the Bot's browser tools wait and nothing is screenshotted or sent to the model.
  takeover: z.boolean(),
  viewing: z.boolean(),
  recording: z.boolean(),
  lastActivityAt: time.nullable(),
  /** Pages asleep; `tabs` are the ones a click, takeover or the Bot's next tool reopens. */
  sleeping: z.boolean().optional(),
});
const modifiers = z.number().int().min(0).max(15); // CDP bitmask: Alt=1 Ctrl=2 Meta=4 Shift=8
// Coordinates are in the frame's CSS pixels; the host maps them to the page, never to the screen.
const point = { x: z.number().min(0).max(16384), y: z.number().min(0).max(16384) };
export const BrowserInputEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("mouse"),
    action: z.enum(["down", "up", "move"]),
    ...point,
    button: z.enum(["none", "left", "middle", "right"]),
    clickCount: z.number().int().min(0).max(3),
    modifiers,
  }),
  z.strictObject({
    type: z.literal("wheel"),
    ...point,
    deltaX: z.number().min(-10000).max(10000),
    deltaY: z.number().min(-10000).max(10000),
    modifiers,
  }),
  z.strictObject({
    type: z.literal("key"),
    action: z.enum(["down", "up"]),
    key: z.string().min(1).max(32),
    code: z.string().max(32),
    modifiers,
  }),
  // Committed text (including IME output); the host inserts it without echoing it to logs.
  z.strictObject({ type: z.literal("text"), text: z.string().min(1).max(1000) }),
]);
/**
 * The size the overlay shows the page at (CSS pixels of the frame box, device pixel
 * ratio). The host fits the page viewport height and the screencast resolution to it.
 */
export const BrowserViewDisplaySchema = z.strictObject({
  width: z.number().int().min(80).max(8192),
  height: z.number().int().min(80).max(8192),
  scale: z.number().min(0.5).max(4),
  /**
   * Frame-rate cap the view asks for. The narrow sidebar only needs a glance (2/s), the
   * wide / fullscreen / takeover views stay at the full 5/s. Omitted = 5/s.
   */
  fps: z.number().int().min(1).max(5).optional(),
});
/** Frames per second for the narrow sidebar and for the larger / taken-over views. */
export const BROWSER_FRAME_FPS_NARROW = 2;
export const BROWSER_FRAME_FPS = 5;
/**
 * Frame channel contract. Frames never enter the business RPC queue: the host hands the
 * window a dedicated MessagePort for one Bot after `browser.view({ visible: true })`, and closes it
 * when the overlay hides. The producer keeps at most `BROWSER_FRAME_IN_FLIGHT` unacknowledged
 * frames, so a busy renderer slows the stream instead of queueing memory.
 */
export const BROWSER_FRAME_CHANNEL = "pibot:browser-frames";
export const BROWSER_FRAME_MAX_BYTES = 512 * 1024;
export const BROWSER_FRAME_IN_FLIGHT = 2;
export const BROWSER_FRAME_MIN_INTERVAL_MS = 1000 / BROWSER_FRAME_FPS;
/**
 * The phone watches the same screencast through the relay, so it gets at most 2 frames per
 * second, pulled one at a time (the next request is the acknowledgement of the previous frame).
 */
export const BROWSER_REMOTE_FPS = 2;
export const BROWSER_REMOTE_FRAME_INTERVAL_MS = 1000 / BROWSER_REMOTE_FPS;
export const BrowserFrameMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("frame"),
    botId: IdSchema,
    groupId: IdSchema.optional(),
    tabId: BrowserTabIdSchema,
    seq: count,
    documentId: IdSchema.optional(),
    mimeType: z.literal("image/jpeg"),
    width: z.number().int().min(1).max(8192),
    height: z.number().int().min(1).max(8192),
    data: z
      .instanceof(Uint8Array)
      .refine((bytes) => bytes.byteLength > 0 && bytes.byteLength <= BROWSER_FRAME_MAX_BYTES),
  }),
  // Sent when the stream stops on the host side (overlay hidden, browser closed, takeover ended).
  z.strictObject({
    type: z.literal("end"),
    botId: IdSchema,
    groupId: IdSchema.optional(),
    reason: z.enum(["hidden", "closed", "idle", "error"]),
  }),
  // Live address bar and tab strip while the overlay is open. The Bot navigates without a
  // business event, so the stream reports tab changes itself; this message is not acknowledged.
  z.strictObject({
    type: z.literal("tabs"),
    botId: IdSchema,
    groupId: IdSchema.optional(),
    tabs: z.array(BrowserTabSchema).max(50),
    takeover: z.boolean(),
  }),
]);
/** Window to host: acknowledges a rendered frame so the producer may send the next one. */
export const BrowserFrameAckSchema = z.strictObject({
  type: z.literal("ack"),
  seq: count,
  groupId: IdSchema.optional(),
});

export type BrowserTab = z.infer<typeof BrowserTabSchema>;
export type BrowserState = z.infer<typeof BrowserStateSchema>;
export type BrowserInputEvent = z.infer<typeof BrowserInputEventSchema>;
export type BrowserViewDisplay = z.infer<typeof BrowserViewDisplaySchema>;
export type BrowserFrameMessage = z.infer<typeof BrowserFrameMessageSchema>;
export type BrowserFrameAck = z.infer<typeof BrowserFrameAckSchema>;

/** Cache/stream key only; never a Bot id or a path segment. */
export const browserProfileKey = (botId: string, groupId?: string) =>
  groupId ? `group:${groupId}:bot:${botId}` : botId;
