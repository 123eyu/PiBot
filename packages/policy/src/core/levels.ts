import type { Level } from "@pibot/protocol-base";

export function effectiveLevel(global: Level, override?: Level): Level {
  return override ?? global;
}
