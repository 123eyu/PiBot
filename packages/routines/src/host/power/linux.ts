import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PowerSupply } from "./lease.ts";

export async function linuxPower(
  signal: AbortSignal,
  root = "/sys/class/power_supply",
): Promise<PowerSupply> {
  const directories = await readdir(root);
  signal.throwIfAborted();
  if (directories.length > 32) return "unknown";
  const text = async (name: string, file: string) => {
    const value = await readFile(join(root, name, file), { encoding: "utf8", signal });
    if (value.length > 100) throw new Error("power_attribute_too_large");
    return value.trim();
  };
  let ac = false,
    discharging = false,
    charging = false;
  for (const name of directories) {
    signal.throwIfAborted();
    const type = await text(name, "type");
    if (["Mains", "USB", "USB_C", "USB_PD"].includes(type))
      ac ||= (await text(name, "online")) === "1";
    if (type === "Battery") {
      const status = await text(name, "status");
      discharging ||= status === "Discharging";
      charging ||= status === "Charging";
    }
  }
  if (discharging && (ac || charging)) return "unknown";
  return ac || charging ? "ac" : discharging ? "battery" : "unknown";
}
