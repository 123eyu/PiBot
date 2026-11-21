import type { ComponentPropsWithRef, CSSProperties } from "react";
import type { AvatarColor } from "./Avatar.tsx";
import { type BrandGlyph, brandGlyphs } from "./brand-glyphs.ts";
import { Icon, type IconName } from "./Icon.tsx";
import styles from "./lively.module.css";

/** Colour vocabulary: the Bot colours plus neutral, shared by tiles, chips and dots. */
export type Tone = Exclude<AvatarColor, "ink" | "gray" | "brown"> | "red" | "neutral";

function classes(...values: (string | false | undefined)[]) {
  return values.filter(Boolean).join(" ");
}

export interface IconTileProps extends Omit<ComponentPropsWithRef<"span">, "children"> {
  icon?: IconName;
  /** A provider's own mark in place of the line icon. */
  brand?: BrandGlyph;
  tone: Tone;
  size?: "sm" | "md" | "lg";
}

/**
 * A small coloured square with a white icon; marks list rows, menu items and section headers. A
 * provider's own mark (`brand`) takes the place of the line icon, filled and slightly larger so it
 * reads at the same weight.
 */
export function IconTile({ icon, brand, tone, size = "md", className, ...props }: IconTileProps) {
  const px = size === "sm" ? 12 : size === "lg" ? 18 : 14;
  return (
    <span
      {...props}
      aria-hidden="true"
      data-tone={tone}
      data-size={size}
      className={classes(styles.tile, className)}
    >
      {brand ? (
        <svg
          width={Math.round(px * 1.17)}
          height={Math.round(px * 1.17)}
          viewBox="0 0 24 24"
          fill="currentColor"
          fillRule="evenodd"
          aria-hidden="true"
          focusable="false"
        >
          <path d={brandGlyphs[brand]} />
        </svg>
      ) : icon ? (
        <Icon name={icon} size={px} strokeWidth={2.2} />
      ) : null}
    </span>
  );
}

export type DotState = "running" | "done" | "failed" | "waiting" | "stopped" | "queued";

export interface StatusDotProps extends Omit<ComponentPropsWithRef<"span">, "children"> {
  state: DotState;
}

/** Run state at a glance; the running dot breathes. Pair it with visible text for meaning. */
export function StatusDot({ state, className, ...props }: StatusDotProps) {
  return (
    <span
      aria-hidden="true"
      {...props}
      data-state={state}
      className={classes(styles.dot, className)}
    />
  );
}

export interface ChipProps extends ComponentPropsWithRef<"span"> {
  tone?: Tone | "ok" | "warn" | "danger";
}

/** A compact label pill; status words and counts. */
export function Chip({ tone = "neutral", className, ...props }: ChipProps) {
  return <span {...props} data-tone={tone} className={classes(styles.chip, className)} />;
}

type PageTone = Exclude<Tone, "red" | "neutral">;

/**
 * Full-page colour: the page tone washes the top, tints switches and selected segments, and is
 * read by section marks (`--page-c`). Spread onto the page's root element's `style`.
 */
export function pageTone(tone: PageTone): CSSProperties {
  return {
    "--page-c": `var(--avatar-${tone})`,
    "--accent-fill": `var(--avatar-${tone})`,
    "--accent-knob": "var(--on-tone)",
    "--accent-ink": `var(--ink-${tone})`,
    backgroundImage:
      "linear-gradient(180deg, color-mix(in srgb, var(--page-c) 13%, transparent), transparent 240px)",
    backgroundRepeat: "no-repeat",
  } as CSSProperties;
}

export interface PageHeadingProps extends ComponentPropsWithRef<"h1"> {
  icon: IconName;
  tone: PageTone;
}

/** A page title led by its coloured mark (等你处理, 例行任务, 记录, 连接 …). */
export function PageHeading({ icon, tone, className, children, ...props }: PageHeadingProps) {
  return (
    <h1 {...props} className={classes(styles.heading, className)}>
      <IconTile icon={icon} tone={tone} size="lg" />
      <span>{children}</span>
    </h1>
  );
}
