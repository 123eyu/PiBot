import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * The tab list a Bot's browser had when its pages were closed to save memory (idle,
 * page-limit eviction, brain standby). Kept in memory and in the Bot's own browser profile
 * directory, so it also survives the brain going away; removed on restore, on "clear
 * browsing data" and when the user closes the tabs. Only http(s) pages are kept.
 */
export const SLEEP_FILE = "pibot-tabs.json";
/** Older lists are dropped: reopening yesterday's pages would surprise more than help. */
const MAX_AGE_MS = 12 * 60 * 60 * 1000;
const MAX_TABS = 8;

const SleepSchema = z.strictObject({
  tabs: z
    .array(
      z.strictObject({
        id: z.string().regex(/^t\d{1,9}$/),
        url: z.string().max(8192),
        title: z.string().max(1000),
      }),
    )
    .min(1)
    .max(MAX_TABS),
  active: z.string().max(16).nullable(),
  savedAt: z.number().int().nonnegative(),
});
export type Sleep = z.infer<typeof SleepSchema>;

export const isRestorable = (url: string) => /^https?:\/\//i.test(url);

export function readSleep(dir: string, now = Date.now()): Sleep | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(dir, SLEEP_FILE), "utf8");
  } catch {
    return undefined; // Nothing saved.
  }
  try {
    const sleep = SleepSchema.parse(JSON.parse(raw));
    if (now - sleep.savedAt <= MAX_AGE_MS) return sleep;
  } catch {
    // A damaged list is only a lost convenience; drop it below.
  }
  writeSleep(dir, undefined);
  return undefined;
}

export function writeSleep(dir: string, sleep: Sleep | undefined) {
  const path = join(dir, SLEEP_FILE);
  try {
    if (!sleep) rmSync(path, { force: true });
    else writeFileSync(path, JSON.stringify(SleepSchema.parse(sleep)), { mode: 0o600 });
  } catch {
    // The in-memory list still restores this process's pages; only standby would lose it.
  }
}
