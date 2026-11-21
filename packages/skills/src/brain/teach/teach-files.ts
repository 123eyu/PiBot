import { readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  RpcError,
  RpcErrorCodes,
  THUMBNAIL_BYTES,
  type ThumbnailContentSchema,
} from "@pibot/skills-contract/full";
import type { z } from "zod";

type ThumbnailContent = z.infer<typeof ThumbnailContentSchema>;

/**
 * Files of one recording: `<data>/bots/<botId>/teach/<recordingId>/`. The background process
 * writes raw keyframes `e<event>.jpg` (keyframes.ts); at stop they become `s<step>.jpg` and the
 * rest is deleted. Saved, discarded and failed recordings lose the whole folder.
 */
export const teachDir = (dataDir: string, botId: string, recordingId: string) =>
  join(dataDir, "bots", botId, "teach", recordingId);

/** Raw keyframes written so far (event indexes). */
export async function keyframeEvents(dir: string) {
  const names = await readdir(dir).catch(() => [] as string[]);
  const found = new Set<number>();
  for (const name of names) {
    const match = /^e(\d{1,4})\.jpg$/.exec(name);
    if (match) found.add(Number(match[1]));
  }
  return found;
}

/** The latest raw keyframe among a step's events, if any was captured. */
export function stepShot(events: readonly number[], shots: ReadonlySet<number>) {
  for (let i = events.length - 1; i >= 0; i--) {
    const index = events[i] as number;
    if (shots.has(index)) return index;
  }
  return undefined;
}

/** Stop: one picture per step, renamed by step index; the other raw keyframes go. */
export async function settleKeyframes(dir: string, perStep: readonly number[][]) {
  const shots = await keyframeEvents(dir);
  const pictured: boolean[] = [];
  const used = new Set<number>();
  for (const [step, events] of perStep.entries()) {
    const shot = stepShot(events, shots);
    pictured.push(shot !== undefined);
    if (shot === undefined) continue;
    used.add(shot);
    await rename(join(dir, `e${shot}.jpg`), join(dir, `s${step}.jpg`));
  }
  await Promise.all(
    [...shots]
      .filter((shot) => !used.has(shot))
      .map((shot) => rm(join(dir, `e${shot}.jpg`), { force: true })),
  );
  return pictured;
}

/**
 * Review deletions renumber steps (RecordingsRepo.keepSteps); pictures follow. New indexes are
 * never above old ones, so renaming in ascending order cannot overwrite a picture still needed.
 */
export async function keepKeyframes(dir: string, total: number, keep: readonly number[]) {
  const kept = new Set(keep);
  for (let old = 0; old < total; old++)
    if (!kept.has(old)) await rm(join(dir, `s${old}.jpg`), { force: true });
  const order = [...kept].sort((a, b) => a - b);
  for (const [next, old] of order.entries())
    if (next !== old)
      await rename(join(dir, `s${old}.jpg`), join(dir, `s${next}.jpg`)).catch(() => {
        // That step had no picture; nothing to move.
      });
}

export async function readThumbnail(path: string, signal: AbortSignal): Promise<ThumbnailContent> {
  const bytes = await readFile(path, { signal }).catch(() => undefined);
  // Keyframes are written under the thumbnail cap; anything else is not ours to show.
  if (!bytes || bytes.length > THUMBNAIL_BYTES)
    throw new RpcError(RpcErrorCodes.unsupported, "teach_thumbnail_unavailable");
  return { type: "image", data: bytes.toString("base64"), mimeType: "image/jpeg" };
}

export async function removeTeachDir(dir: string) {
  await rm(dir, { recursive: true, force: true });
}
