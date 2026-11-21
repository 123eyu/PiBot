import { getDocumentAsync } from "expo-document-picker";
import {
  launchCameraAsync,
  launchImageLibraryAsync,
  requestCameraPermissionsAsync,
} from "expo-image-picker";
import type { SourceFile } from "../share/prepare-native.ts";

export type PickSource = "library" | "camera" | "files";

const fallbackName = (prefix: string, mimeType?: string) =>
  `${prefix}-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}.${
    mimeType === "image/png" ? "png" : "jpg"
  }`;

/**
 * Opens the system photo picker, camera or document picker. The photo picker and the
 * document picker need no permission (they hand over only what the person picks); the camera asks
 * once. `undefined` = cancelled; the error `native_cancelled` = camera permission refused.
 */
export async function pickNative(
  source: PickSource,
  limit: number,
): Promise<SourceFile[] | undefined> {
  if (source === "files") {
    const result = await getDocumentAsync({
      multiple: limit > 1,
      // The picked URI is only guaranteed readable as the picker's cache copy (iOS security
      // scope, Android content URIs); the share store copies it from there.
      copyToCacheDirectory: true,
    });
    if (result.canceled) return undefined;
    // All of them: what does not fit is skipped and counted in the notice.
    return result.assets.map((asset) => ({
      uri: asset.uri,
      name: asset.name,
      mimeType: asset.mimeType,
      size: asset.size,
    }));
  }
  if (source === "camera") {
    const permission = await requestCameraPermissionsAsync();
    if (!permission.granted) throw new Error("native_cancelled");
  }
  const options = {
    mediaTypes: ["images" as const],
    // Prepare re-encodes to JPEG within the computer's limits anyway; no second lossy pass here.
    quality: 1,
    exif: false,
  };
  const result =
    source === "camera"
      ? await launchCameraAsync(options)
      : await launchImageLibraryAsync({
          ...options,
          allowsMultipleSelection: limit > 1,
          selectionLimit: limit,
          orderedSelection: true,
        });
  if (result.canceled) return undefined;
  return result.assets.map((asset) => ({
    uri: asset.uri,
    name: asset.fileName || fallbackName(source === "camera" ? "photo" : "image", asset.mimeType),
    // Some Android galleries leave the type out; every asset here is an image by the filter.
    mimeType: asset.mimeType?.startsWith("image/") ? asset.mimeType : "image/jpeg",
    size: asset.fileSize,
    width: asset.width,
    height: asset.height,
  }));
}
