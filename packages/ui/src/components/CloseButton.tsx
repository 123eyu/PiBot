import type { ComponentPropsWithRef } from "react";
import styles from "./CloseButton.module.css";
import { Icon } from "./Icon.tsx";

export interface CloseButtonProps
  extends Omit<ComponentPropsWithRef<"button">, "children" | "type" | "aria-label"> {
  label: string;
}

/** The owner retains dismissal, dirty-state and focus rules; this component only supplies the control. */
export function CloseButton({ label, title = label, className, ...props }: CloseButtonProps) {
  return (
    <button
      {...props}
      type="button"
      aria-label={label}
      title={title}
      data-close-button="true"
      className={[styles.button, className].filter(Boolean).join(" ")}
    >
      <Icon name="close" size={16} />
    </button>
  );
}
