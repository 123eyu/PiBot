import { type ComponentPropsWithRef, type CSSProperties, type ReactNode, useId } from "react";
import styles from "./components.module.css";

function classes(...values: (string | undefined)[]) {
  return values.filter(Boolean).join(" ");
}

export interface ButtonProps extends ComponentPropsWithRef<"button"> {
  variant?: "primary" | "secondary" | "ghost" | "pill" | "circle";
  loading?: boolean;
}

export function Button({
  variant = "primary",
  loading = false,
  type = "button",
  disabled,
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={classes(styles.button, styles[variant], className)}
    >
      {loading && <span className={styles.spinner} aria-hidden="true" />}
      {children}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonProps, "aria-label"> {
  label: string;
}

export function IconButton({
  label,
  className,
  variant = "secondary",
  children,
  ...props
}: IconButtonProps) {
  return (
    <Button
      {...props}
      variant={variant}
      aria-label={label}
      className={classes(styles.iconButton, className)}
    >
      <span aria-hidden="true" className={styles.icon}>
        {children}
      </span>
    </Button>
  );
}

export interface TextFieldProps extends ComponentPropsWithRef<"input"> {
  label: string;
  /** Keep the accessible label when the surrounding layout already shows the field name. */
  hideLabel?: boolean;
  description?: ReactNode;
  error?: ReactNode;
  containerClassName?: string;
}

export function TextField({
  label,
  hideLabel = false,
  description,
  error,
  id,
  className,
  containerClassName,
  "aria-describedby": describedBy,
  ...props
}: TextFieldProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const descriptionId = `${inputId}-description`;
  const errorId = `${inputId}-error`;
  const descriptions = [
    describedBy,
    description ? descriptionId : undefined,
    error ? errorId : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes(styles.field, containerClassName)}>
      <label htmlFor={inputId} className={hideLabel ? styles.visuallyHidden : styles.label}>
        {label}
      </label>
      <input
        {...props}
        id={inputId}
        aria-invalid={error ? true : props["aria-invalid"]}
        aria-describedby={descriptions || undefined}
        className={classes(styles.input, className)}
      />
      {description && (
        <div id={descriptionId} className={styles.description}>
          {description}
        </div>
      )}
      {error && (
        <div id={errorId} className={styles.error} role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

export interface SwitchProps
  extends Omit<
    ComponentPropsWithRef<"button">,
    "onChange" | "children" | "aria-checked" | "role" | "type" | "aria-label"
  > {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

export function Switch({
  label,
  checked,
  onCheckedChange,
  className,
  onClick,
  ...props
}: SwitchProps) {
  return (
    <button
      {...props}
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      className={classes(styles.switch, className)}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onCheckedChange(!checked);
      }}
    >
      <span className={styles.knob} aria-hidden="true" />
    </button>
  );
}

export interface SegmentOption<T extends string> {
  title?: string;
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  label: string;
  options: readonly SegmentOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  disabled?: boolean;
  name?: string;
  className?: string;
}

export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onValueChange,
  disabled,
  name,
  className,
}: SegmentedControlProps<T>) {
  const id = useId();
  const index = options.findIndex((option) => option.value === value);
  // Native radios supply arrow-key navigation, focus management, and form semantics.
  return (
    <fieldset
      disabled={disabled}
      className={classes(styles.segmented, className)}
      data-empty={index < 0 || undefined}
      style={{ "--seg-count": options.length, "--seg-index": Math.max(index, 0) } as CSSProperties}
    >
      <legend className={styles.visuallyHidden}>{label}</legend>
      {options.map((option) => (
        <label key={option.value} className={styles.segment}>
          <input
            type="radio"
            name={name ?? id}
            value={option.value}
            checked={value === option.value}
            disabled={option.disabled}
            onChange={() => onValueChange(option.value)}
          />
          <span title={option.title}>{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

export type CardProps = ComponentPropsWithRef<"div">;

export function Card({ className, ...props }: CardProps) {
  return <div {...props} className={classes(styles.card, className)} />;
}
