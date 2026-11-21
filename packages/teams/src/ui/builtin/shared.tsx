import type { TranslationKey } from "@pibot/i18n";
import {
  type BuiltinCatalog,
  type BuiltinRoleView,
  CategorySchema,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";
import {
  avatarColors,
  avatarEyes,
  avatarShapes,
  useRpc,
  useSettings,
  type useT,
} from "@pibot/renderer-kit";
import { Avatar, Icon, type IconName } from "@pibot/ui";
import { type CSSProperties, useCallback, useEffect, useState } from "react";
import styles from "./builtin.module.css";

/**
 * The built-in catalog in the UI language; reloaded when the language or models change.
 * `enabled: false` skips the read (callers that only sometimes need it).
 */
export function useBuiltinCatalog(enabled = true) {
  const { peer: rpcPeer } = useRpc();
  const peer = enabled ? rpcPeer : null;
  const { language } = useSettings();
  const [catalog, setCatalog] = useState<BuiltinCatalog>();
  const [error, setError] = useState(false);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: language and version trigger a reload.
  useEffect(() => {
    if (!peer) return;
    let active = true;
    setError(false);
    peer
      .call("builtin.catalog", undefined)
      .then((value) => {
        if (active) setCatalog(value);
      })
      .catch(() => {
        if (active) setError(true);
      });
    // Image models decide which roles are available; a provider change can add one.
    const off = peer.on("providers.changed", () => setVersion((v) => v + 1));
    return () => {
      active = false;
      off();
    };
  }, [peer, language, version]);
  return { catalog, error, loading: !catalog && !error, reload };
}

export function RoleAvatar({ role, size }: { role?: BuiltinRoleView; size: number }) {
  return (
    <Avatar
      size={size}
      label={role?.defaultBotName ?? ""}
      shape={avatarShapes.find((v) => v === role?.avatar.shape) ?? "blob"}
      color={avatarColors.find((v) => v === role?.avatar.color) ?? "gray"}
      eyes={avatarEyes.find((v) => v === role?.avatar.eyes) ?? "marks"}
    />
  );
}

/**
 * A role's own colour for its card hover, ring and buttons (`--c` fill, `--ci` text on a
 * tint). A gray role would vanish as a ring, so it takes the brand violet instead.
 */
export function roleTone(role?: Pick<BuiltinRoleView, "avatar">): CSSProperties {
  const found = avatarColors.find((v) => v === role?.avatar.color);
  const color = !found || found === "gray" ? "violet" : found;
  return { "--c": `var(--avatar-${color})`, "--ci": `var(--ink-${color})` } as CSSProperties;
}

/** Each declared default with its level, so a chip can carry the level's colour. */
export function permissionItems(
  role: Pick<BuiltinRoleView, "permissionOverrides">,
  t: ReturnType<typeof useT>,
): { line: string; tone: "ok" | "warn" | "danger" }[] {
  return CategorySchema.options.flatMap((category) => {
    const level = role.permissionOverrides[category];
    return level
      ? [
          {
            line: t("builtin.permissionLine", {
              category: t(`permissions.category.${category}`),
              level:
                category === "run_command" && level === "always"
                  ? t("builtin.permission.sandboxedCommand")
                  : t(`permissions.level.${level}`),
            }),
            tone: level === "always" ? "ok" : level === "ask" ? "warn" : "danger",
          } as const,
        ]
      : [];
  });
}

/** "运行命令：询问 · 对外发送：不允许" for a role's declared defaults. */
export function permissionLines(
  role: Pick<BuiltinRoleView, "permissionOverrides">,
  t: ReturnType<typeof useT>,
): string[] {
  return permissionItems(role, t).map((item) => item.line);
}

// Profession icons are semantic names in the content; the app maps them to its own icon set.
const PROFESSION_ICONS: Record<string, IconName> = {
  code: "terminal",
  lightbulb: "star",
  palette: "palette",
  pen: "edit",
  megaphone: "globe",
  chart: "chart",
  book: "file",
  school: "users",
  cart: "inbox",
  briefcase: "briefcase",
  server: "settings",
  rocket: "rocket",
};
export function ProfessionIcon({ name }: { name: string }) {
  return (
    <span className={styles.icon} aria-hidden="true">
      <Icon name={PROFESSION_ICONS[name] ?? "user"} size={16} />
    </span>
  );
}

export function builtinError(error: unknown): TranslationKey {
  if (error instanceof RpcError && error.code === RpcErrorCodes.busy) return "builtin.error.busy";
  if (error instanceof RpcError && error.message === "builtin_limit") return "builtin.error.limit";
  if (error instanceof RpcError && error.message === "builtin_no_image_model")
    return "builtin.error.noImage";
  if (
    error instanceof RpcError &&
    (error.code === RpcErrorCodes.timeout || error.code === RpcErrorCodes.closed)
  )
    return "workspace.createUncertain";
  return "builtin.error.failed";
}
