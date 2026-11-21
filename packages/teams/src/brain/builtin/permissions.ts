import type { Category, Level, PermissionLevels } from "@pibot/protocol";
import { tightenOverrides } from "@pibot/protocol";

/** Only callers holding application-owned built-in content may use this exception. */
export function builtinPermission(global: PermissionLevels, category: Category, level?: Level) {
  if (category === "run_command" && level === "always")
    return global.run_command === "never" ? undefined : "always";
  return level === undefined
    ? undefined
    : (tightenOverrides(global, { [category]: level }).overrides[category] as Level | undefined);
}
