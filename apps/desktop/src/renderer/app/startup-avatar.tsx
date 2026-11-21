import type { Bot } from "@pibot/protocol";
import { botAvatarLook } from "@pibot/renderer-kit/bot-avatar";
import { Avatar, GroupAvatar } from "@pibot/ui";
import type { StartupAvatarLook } from "../../shared/startup-snapshot.ts";
import styles from "./startup-display.module.css";

type AvatarSource = Pick<Bot, "avatarShape" | "avatarColor" | "avatarEyes" | "avatarImage">;

export function snapshotLook(bot?: AvatarSource, unknown?: boolean): StartupAvatarLook {
  return { ...botAvatarLook(bot, unknown), ...(bot?.avatarImage ? { image: true } : {}) };
}
export function snapshotMembers(bots: readonly (AvatarSource | undefined)[]) {
  return {
    members: bots.slice(0, 4).map((bot) => snapshotLook(bot, !bot)),
    memberCount: Math.min(100, bots.length),
  };
}

export function CachedAvatar({
  look,
  size,
  label,
}: {
  look?: StartupAvatarLook;
  size?: number;
  label: string;
}) {
  // The picture itself is not cached; a neutral disc keeps the real avatar's footprint.
  if (look?.image)
    return (
      <span
        className={styles.avatarImage}
        style={{ width: size, height: size }}
        role="img"
        aria-label={label}
      />
    );
  const { shape, color, eyes } = botAvatarLook(
    look && { avatarShape: look.shape, avatarColor: look.color, avatarEyes: look.eyes },
  );
  return <Avatar shape={shape} color={color} eyes={eyes} size={size} label={label} />;
}

export function CachedGroupAvatar({
  members = [],
  memberCount,
  size,
}: {
  members?: StartupAvatarLook[];
  memberCount?: number;
  size: number;
}) {
  // GroupAvatar only draws the first members and counts the rest for its "+N" tile.
  const count = Math.max(members.length, memberCount ?? 0);
  return (
    <GroupAvatar size={size}>
      {Array.from({ length: count }, (_, index) => (
        <CachedAvatar
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed, display-only member order
          key={index}
          look={members[index] ?? members[0]}
          label=""
        />
      ))}
    </GroupAvatar>
  );
}
