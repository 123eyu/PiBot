import { hostname } from "node:os";

/*
 * A paired runner is named after the machine it runs on, not after the product: people pick the
 * device in the desktop's device list and in approval cards, and three machines all called
 * "Pi Bot Runner" could not be told apart. `pibot runner pair --name "Build box"` overrides it at
 * pairing time (the desktop can rename the device afterwards).
 *
 * The name is shown in another person's app, so it is bounded here as well as by DeviceNameSchema
 * on the desktop: trimmed, no control or formatting characters, at most 80 characters.
 */
export function runnerDeviceName(requested: string | undefined): string {
  const cleaned = (requested ?? "")
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const fallback = hostname()
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const name = cleaned || fallback || "Pi Bot Runner";
  return [...name].slice(0, 80).join("");
}
