import { PHONE_IMAGE_MAX_BYTES, PHONE_IMAGE_MAX_EDGE, type PhoneMediaItem } from "@pibot/protocol";
import {
  type Asset,
  getAssetInfoAsync,
  getAssetsAsync,
  getPermissionsAsync,
  MediaType,
  requestPermissionsAsync,
  SortBy,
} from "expo-media-library/legacy";
import { getThumbnailAsync } from "expo-video-thumbnails";
import { Platform } from "react-native";
import { encodeJpeg } from "./jpeg-native.ts";
import type { PhoneMediaSource } from "./serve.ts";

const KINDS = ["photo", "video"] as const;
function item(asset: Asset): PhoneMediaItem {
  return {
    id: asset.id,
    kind: asset.mediaType === MediaType.video ? "video" : "photo",
    takenAt: new Date(asset.creationTime || asset.modificationTime || 0).toISOString(),
    width: Math.max(0, Math.round(asset.width)),
    height: Math.max(0, Math.round(asset.height)),
    ...(asset.mediaType === MediaType.video
      ? { durationMs: Math.round(Math.max(0, asset.duration) * 1000) }
      : {}),
    // iOS lists location presence for every asset; Android hides it without the media-location
    // permission, which Pi Bot never requests, so there the phone cannot tell.
    hasLocation: Platform.OS === "ios" ? !!asset.location : null,
  };
}

/** Asks for read access (photos and videos) when the owner turns the switch on. */
export async function requestMediaRead() {
  const answer = await requestPermissionsAsync(false, [...KINDS]);
  return answer.granted;
}

/**
 * Maintainers 2026-11-12: viewing a listed photo always failed on Android with "not found". On Android
 * 10+ getAssetInfoAsync always reads the photo's GPS location and throws without the
 * media-location permission, which Pi Bot deliberately never requests. Android prepares the image
 * from the address the list returned instead (no location is read); the computer lists before it
 * views, and an unknown id is answered "not found, list again".
 */
const LISTED_MAX = 500;
const listed = new Map<string, Asset>();
function remember(asset: Asset) {
  listed.delete(asset.id);
  listed.set(asset.id, asset);
  if (listed.size > LISTED_MAX) listed.delete(listed.keys().next().value as string);
}

/** expo-media-library; iOS "selected photos only" limits what is listed natively. */
export const nativeMedia: PhoneMediaSource = {
  async permission() {
    const answer = await getPermissionsAsync(false, [...KINDS]);
    if (!answer.granted) return "denied";
    return answer.accessPrivileges === "limited" ? "limited" : "granted";
  },
  async list(query) {
    const page = await getAssetsAsync({
      first: query.limit ?? 50,
      ...(query.after ? { after: query.after } : {}),
      mediaType:
        query.kind === "photo"
          ? MediaType.photo
          : query.kind === "video"
            ? MediaType.video
            : [MediaType.photo, MediaType.video],
      sortBy: [[SortBy.creationTime, false]],
      ...(query.from ? { createdAfter: Date.parse(query.from) } : {}),
      ...(query.to ? { createdBefore: Date.parse(query.to) } : {}),
    });
    for (const asset of page.assets.slice(0, 100)) remember(asset);
    return {
      items: page.assets.slice(0, 100).map(item),
      nextAfter: page.hasNextPage && page.endCursor ? page.endCursor.slice(0, 200) : null,
    };
  },
  async prepare(id) {
    let source: string;
    let meta: PhoneMediaItem;
    if (Platform.OS === "android") {
      const asset = listed.get(id);
      if (!asset) return undefined; // Not listed in this app session: list again.
      source = asset.uri;
      meta = item(asset);
    } else {
      let info: Awaited<ReturnType<typeof getAssetInfoAsync>>;
      try {
        info = await getAssetInfoAsync(id, { shouldDownloadFromNetwork: true });
      } catch {
        return undefined; // Deleted, or outside the photos the owner shared.
      }
      source = info.localUri ?? info.uri;
      meta = item(info);
    }
    const frame =
      meta.kind === "video"
        ? await getThumbnailAsync(source, { time: 0, quality: 0.8 })
        : { uri: source, width: meta.width, height: meta.height };
    const jpeg = await encodeJpeg(
      frame.uri,
      { width: frame.width, height: frame.height },
      { maxEdge: PHONE_IMAGE_MAX_EDGE, maxBytes: PHONE_IMAGE_MAX_BYTES },
      true,
    );
    return { item: meta, width: jpeg.width, height: jpeg.height, base64: jpeg.base64 ?? "" };
  },
};
