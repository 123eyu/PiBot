import { IdSchema } from "@pibot/protocol";
import { z } from "zod";

export interface MemoryNoticeStorage {
  read(): ReadonlySet<string>;
  write(ids: ReadonlySet<string>): void;
}
const idsSchema = z.array(IdSchema).max(100);

// Only dismissed proposal UUIDs are cached, never memory text or private undo images.
export function memoryNoticeStorage(botId: string): MemoryNoticeStorage {
  const key = `pibot.auto-memory-notices.v1.${botId}`;
  return {
    read() {
      try {
        const parsed = idsSchema.safeParse(JSON.parse(localStorage.getItem(key) ?? "[]"));
        return new Set(parsed.success ? parsed.data : []);
      } catch {
        // Storage may be unavailable; the persisted proposal age remains a restart fallback.
        return new Set();
      }
    },
    write(ids) {
      try {
        if (ids.size) localStorage.setItem(key, JSON.stringify([...ids].slice(-100)));
        else localStorage.removeItem(key);
      } catch {
        // Dismissing a hint must not block chat or mutate memory if the UI cache is unavailable.
      }
    },
  };
}
