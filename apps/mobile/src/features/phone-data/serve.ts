import {
  type PhoneDataError,
  type PhoneDataMethod,
  type PhoneMediaGetSchema,
  type PhoneMediaItem,
  type PhoneMediaPage,
  type PhoneMediaQuery,
  type PhoneMediaSlice,
  type PhoneSmsCode,
  type PhoneSmsQuerySchema,
  PREVIEW_DATA_CHUNK,
  phoneDataError,
  RpcError,
} from "@pibot/protocol";
import type { z } from "zod";
import type { DesktopCallHandler } from "../../transport/desktop-calls.ts";
import type { PhoneDataLogEntry, PhoneDataPrefs } from "./prefs.ts";

/** Photos and videos (expo-media-library in the app, a fixture in the probes). */
export interface PhoneMediaSource {
  permission(): Promise<"granted" | "limited" | "denied">;
  list(query: PhoneMediaQuery): Promise<Omit<PhoneMediaPage, "limited">>;
  /** A JPEG within the image limits (photo, or a video's cover); undefined when the item is gone. */
  prepare(
    id: string,
  ): Promise<{ item: PhoneMediaItem; width: number; height: number; base64: string } | undefined>;
}
/** SMS verification codes (the Android module in the app, a fixture in the probes). */
export interface PhoneSmsSource {
  /** consent = Google Play services can show the SMS User Consent sheet. */
  capabilities(): Promise<{ consent: boolean; readSms: "granted" | "denied" | "undeclared" }>;
  /** Throws phone_consent_denied / phone_sms_timeout as RpcErrors. */
  waitConsent(
    senderHint: string | undefined,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<PhoneSmsCode>;
  /** READ_SMS fallback: newest code of the last 10 minutes, polling until `waitMs` passes. */
  scanRecent(
    senderHint: string | undefined,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<PhoneSmsCode>;
}
export interface PhoneDataDeps {
  platform: "ios" | "android";
  prefs(): Promise<PhoneDataPrefs>;
  media?: PhoneMediaSource;
  sms?: PhoneSmsSource;
  readPages?: {
    supported(kind: "calls" | "notifications", signal: AbortSignal): Promise<boolean>;
    read(
      kind: "calls" | "notifications",
      input: unknown,
      signal: AbortSignal,
    ): Promise<{ items: readonly unknown[] }>;
  };
  /** Aborted the moment this computer's local switches change. */
  localRevoked?(): AbortSignal;
  log(entry: PhoneDataLogEntry): Promise<void>;
}
// The slices of one prepared image are fetched back to back; the slot keeps memory to one image.
const SLICE_TTL_MS = 60_000;
const FIXED_CODE = /^capability_off$|^phone_[a-z_]{2,40}$|^unsupported_platform$/;

/**
 * Answers the computer's phone-data calls for one paired computer: each category only while its switch
 * is on, the system permission or consent sheet still deciding on top. Every answer, allowed or
 * refused, lands in the phone's "recently read" list (category and count, never content).
 */
export function phoneDataHandler(deps: PhoneDataDeps): DesktopCallHandler {
  let prepared: { id: string; at: number; value: PhoneMediaSlice; data: string } | undefined;
  let waiting = false;
  const note = (category: PhoneDataLogEntry["category"], count: number, outcome: string) =>
    deps.log({ at: new Date().toISOString(), category, count, outcome }).catch(() => {
      // The list is a courtesy display; a full or failed write must not fail the answer.
    });
  const refuse = async (category: PhoneDataLogEntry["category"], code: PhoneDataError) => {
    await note(category, 0, code);
    phoneDataError(code);
  };
  async function media(query: PhoneMediaQuery): Promise<PhoneMediaPage> {
    if (!(await deps.prefs()).media) return refuse("media", "phone_category_off");
    if (!deps.media) return refuse("media", "unsupported_platform");
    const permission = await deps.media.permission();
    if (permission === "denied") return refuse("media", "phone_permission_denied");
    let page: Awaited<ReturnType<NonNullable<typeof deps.media>["list"]>>;
    try {
      page = await deps.media.list(query);
    } catch (error) {
      // Maintainers 2026-11-12: listings failed with no recorded cause; keep the library's own code
      // (fixed identifiers only, never paths or names) so the next failure is explained.
      const code =
        error && typeof error === "object" && "code" in error && typeof error.code === "string"
          ? error.code
          : error instanceof Error
            ? error.name
            : "unknown";
      console.warn(
        JSON.stringify({
          module: "phone-data",
          event: "media_list_failed",
          code: /^[A-Za-z_][\w.]{0,60}$/.test(code) ? code : "unknown",
        }),
      );
      throw error;
    }
    await note("media", page.items.length, "allowed");
    return { ...page, limited: permission === "limited" };
  }
  async function mediaGet(input: z.output<typeof PhoneMediaGetSchema>): Promise<PhoneMediaSlice> {
    if (!(await deps.prefs()).media) return refuse("media_get", "phone_category_off");
    if (!deps.media) return refuse("media_get", "unsupported_platform");
    if ((await deps.media.permission()) === "denied")
      return refuse("media_get", "phone_permission_denied");
    const fresh = prepared && prepared.id === input.id && Date.now() - prepared.at < SLICE_TTL_MS;
    if (input.offset === 0 || !fresh) {
      const image = await deps.media.prepare(input.id);
      if (!image) return refuse("media_get", "phone_media_not_found");
      prepared = {
        id: input.id,
        at: Date.now(),
        data: image.base64,
        value: {
          item: image.item,
          width: image.width,
          height: image.height,
          total: image.base64.length,
          offset: 0,
          chunk: "",
        },
      };
      if (input.offset === 0) await note("media_get", 1, "allowed");
    }
    const current = prepared as NonNullable<typeof prepared>;
    if (input.offset > current.data.length) return refuse("media_get", "phone_media_not_found");
    const chunk = current.data.slice(input.offset, input.offset + PREVIEW_DATA_CHUNK);
    if (input.offset + chunk.length >= current.data.length) prepared = undefined;
    return { ...current.value, offset: input.offset, chunk };
  }
  async function smsCode(
    input: z.output<typeof PhoneSmsQuerySchema>,
    signal: AbortSignal,
  ): Promise<PhoneSmsCode> {
    if (deps.platform !== "android" || !deps.sms) return refuse("sms_code", "unsupported_platform");
    const prefs = await deps.prefs();
    if (!prefs.smsCode) return refuse("sms_code", "phone_category_off");
    if (waiting) return refuse("sms_code", "phone_busy");
    const caps = await deps.sms.capabilities();
    const fallback = prefs.smsFallback && caps.readSms !== "undeclared";
    if (!caps.consent && !fallback) return refuse("sms_code", "unsupported_platform");
    if (!caps.consent && caps.readSms !== "granted")
      return refuse("sms_code", "phone_permission_denied");
    waiting = true;
    try {
      const code = caps.consent
        ? await deps.sms.waitConsent(input.senderHint, input.waitMs, signal)
        : await deps.sms.scanRecent(input.senderHint, input.waitMs, signal);
      await note("sms_code", 1, "allowed");
      return code;
    } catch (error) {
      if (error instanceof RpcError) await note("sms_code", 0, error.message.slice(0, 40));
      throw error;
    } finally {
      waiting = false;
    }
  }
  // A local switch change aborts `localRevoked()` at once, which cancels the native read
  // and refuses its late page. The last check runs after every await, so nothing awaited sits
  // between it and the reply (the log write is not awaited after it).
  async function readPage(kind: "calls" | "notifications", params: unknown, signal: AbortSignal) {
    signal.throwIfAborted();
    const local = deps.localRevoked?.() ?? new AbortController().signal;
    if (deps.platform !== "android" || !deps.readPages) return refuse(kind, "unsupported_platform");
    if (local.aborted || !(await deps.prefs())[kind]) return refuse(kind, "phone_category_off");
    let page: { items: readonly unknown[] };
    try {
      page = await deps.readPages.read(kind, params, AbortSignal.any([signal, local]));
    } catch (error) {
      if (local.aborted && !signal.aborted) return refuse(kind, "phone_category_off");
      // Only fixed snake_case codes are recorded, never a native or exception message.
      const code =
        error instanceof RpcError && FIXED_CODE.test(error.message)
          ? error.message
          : "phone_failed";
      await note(kind, 0, signal.aborted ? "cancelled" : code);
      throw error;
    }
    signal.throwIfAborted();
    const on = (await deps.prefs())[kind];
    signal.throwIfAborted();
    if (local.aborted || !on) return refuse(kind, "phone_category_off");
    void note(kind, page.items.length, "allowed");
    return page;
  }
  return async (method: PhoneDataMethod, params: unknown, signal: AbortSignal) => {
    if (method === "phoneData.calls") return readPage("calls", params, signal);
    if (method === "phoneData.notifications") return readPage("notifications", params, signal);
    if (method === "phoneData.media") return media(params as PhoneMediaQuery);
    if (method === "phoneData.mediaGet")
      return mediaGet(params as z.output<typeof PhoneMediaGetSchema>);
    return smsCode(params as z.output<typeof PhoneSmsQuerySchema>, signal);
  };
}
