import { rateKey } from "@pibot/link/room";
import type { RateLimitBinding, RelayEnv } from "./types.ts";

async function bindingAllows(binding: RateLimitBinding | undefined, key: string) {
  if (!binding) return undefined;
  try {
    return (await binding.limit({ key })).success;
  } catch {
    return undefined;
  }
}
export async function connectionAllowed(request: Request, env: RelayEnv) {
  const key = rateKey(request.headers.get("CF-Connecting-IP") ?? "local");
  const bound = await bindingAllows(env.CONNECTION_LIMITER, key);
  if (bound !== undefined) return bound;
  const stub = env.ROOMS.get(env.ROOMS.idFromName(`ip:${key}`));
  return (await stub.fetch("https://room.internal/_ip", { method: "POST" })).status === 204;
}
export async function pushAllowed(roomId: string, env: RelayEnv) {
  const bound = await bindingAllows(env.PUSH_LIMITER, roomId);
  if (bound !== undefined) return bound;
  const stub = env.ROOMS.get(env.ROOMS.idFromName(`room:${roomId}`));
  return (await stub.fetch("https://room.internal/_push", { method: "POST" })).status === 204;
}
