import { createRelay } from "./worker/handler.ts";

export { Room } from "./room/room.ts";
export { Stats } from "./stats/stats.ts";
export type { RelayEnv } from "./worker/types.ts";
export default createRelay();
