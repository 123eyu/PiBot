import { Children, cloneElement, type ReactElement } from "react";
import styles from "./GroupAvatar.module.css";

/** One compact identity across lists, headers and templates; member details remain in the group. */
export function GroupAvatar({
  children,
  size = 44,
}: {
  children: ReactElement<{ size?: number }>[];
  size?: number;
}) {
  const members = Children.toArray(children) as ReactElement<{ size?: number }>[];
  const shown = members.slice(0, members.length > 4 ? 3 : 4);
  const count = Math.min(members.length, 4);
  const memberSize = count === 1 ? size : Math.round(size * 0.59);
  return (
    <span
      className={styles.group}
      data-count={count}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {shown.map((member) => (
        <span key={member.key} className={styles.member}>
          {cloneElement(member, { size: memberSize })}
        </span>
      ))}
      {members.length > 4 && (
        <span
          className={`${styles.member} ${styles.more}`}
          style={{
            width: memberSize,
            height: memberSize,
            fontSize: Math.max(9, Math.round(size * 0.22)),
          }}
        >
          +{members.length - shown.length}
        </span>
      )}
    </span>
  );
}
