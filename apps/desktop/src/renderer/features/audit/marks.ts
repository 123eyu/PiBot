import type { IconName, Tone } from "@pibot/ui";
import type { ActivityType } from "./type-filter.ts";

/** One colour and mark per record type, shared by the row tile and the detail badge. */
const marks: Record<Exclude<ActivityType, "all">, { icon: IconName; tone: Tone }> = {
  approval: { icon: "shield", tone: "amber" },
  scheduling: { icon: "clock", tone: "orange" },
  run: { icon: "terminal", tone: "orange" },
  file: { icon: "file", tone: "blue" },
  web: { icon: "globe", tone: "green" },
  send: { icon: "send", tone: "violet" },
  connectors: { icon: "plug", tone: "teal" },
  phone: { icon: "phone", tone: "pink" },
  collaboration: { icon: "users", tone: "teal" },
  identity: { icon: "key", tone: "violet" },
  computer: { icon: "hand", tone: "pink" },
  background: { icon: "server", tone: "teal" },
};

export function activityMark(type: ActivityType) {
  return type === "all" ? { icon: "audit" as const, tone: "teal" as const } : marks[type];
}
