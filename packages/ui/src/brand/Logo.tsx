import { useId } from "react";

export type LogoVariant = "mark" | "app-mac" | "app-win" | "app-linux" | "tray";
export type LogoTone = "violet" | "ink" | "paper" | "night";
export interface LogoProps {
  variant?: LogoVariant;
  tone?: LogoTone;
  size?: number;
  label?: string;
  className?: string;
}

const blob = "M50 6 C80 6 94 20 94 50 C94 80 80 94 50 94 C20 94 6 80 6 50 C6 20 20 6 50 6 Z";
const square = "M0 0 H100 V100 H0 Z";
const roundedSquare = "M22 0 H78 Q100 0 100 22 V78 Q100 100 78 100 H22 Q0 100 0 78 V22 Q0 0 22 0 Z";
const circle = "M50 3 A47 47 0 1 1 49.9 3 Z";

export function Logo({
  variant = "mark",
  tone = variant === "tray" ? "ink" : "violet",
  size = 96,
  label = "Pi Bot",
  className,
}: LogoProps) {
  const id = useId();
  const tray = variant === "tray";
  const shape =
    variant === "app-mac"
      ? square
      : variant === "app-linux"
        ? circle
        : variant === "app-win" || tray
          ? blob
          : roundedSquare;
  const fill = tray ? `var(--tray-${tone === "paper" ? "paper" : "ink"})` : `var(--logo-${tone})`;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 100 100"
      width={size}
      height={size}
      role="img"
      aria-label={label}
      className={className}
      data-variant={variant}
      style={{ display: "inline-block", flexShrink: 0, verticalAlign: "middle" }}
    >
      <title>{label}</title>
      <defs>
        <g
          id={`${id}-eyes`}
          fill="none"
          strokeWidth={size <= 22 ? 10.5 : 9.5}
          strokeLinecap="round"
        >
          <path d="M38 41 L40 57" />
          <path d="M62 41 L60 57" />
        </g>
        {tray && (
          <mask id={`${id}-mask`} maskUnits="userSpaceOnUse" x={0} y={0} width={100} height={100}>
            <rect width={100} height={100} fill="var(--logo-mask-solid)" />
            <use href={`#${id}-eyes`} stroke="var(--logo-mask-cutout)" />
          </mask>
        )}
      </defs>
      <path
        d={shape}
        fill={fill}
        stroke={fill}
        strokeWidth={variant === "app-win" || tray ? 6 : 0}
        strokeLinejoin="round"
        mask={tray ? `url(#${id}-mask)` : undefined}
      />
      {!tray && <use href={`#${id}-eyes`} stroke={`var(--logo-${tone}-ink)`} />}
    </svg>
  );
}
