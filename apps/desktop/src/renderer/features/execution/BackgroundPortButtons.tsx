import { useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useState } from "react";

/** Ports listed before the rest folds into "N more ports"; a dev server tree can listen on twenty. */
const VISIBLE_PORTS = 3;

/**
 * Ports in the order they opened, newest first. The brain only reports ports the command listens
 * on right now, so a port missing from the latest list has been closed: it is dropped instead of
 * leaving a button whose only outcome is `port_unavailable`.
 */
export function useRecentPorts(ports: number[]): number[] {
  // Ports are positive integers; the joined list is a stable stand-in for its contents, so the
  // order survives re-renders that hand over an equal array.
  const key = ports.join(",");
  const [order, setOrder] = useState(ports);
  useEffect(() => {
    const current = key ? key.split(",").map(Number) : [];
    setOrder((previous) => {
      const live = new Set(current);
      const next = previous.filter((port) => live.has(port));
      for (const port of current) if (!next.includes(port)) next.unshift(port);
      const same =
        next.length === previous.length && next.every((port, index) => port === previous[index]);
      return same ? previous : next;
    });
  }, [key]);
  return order;
}

/**
 * "Open in Bot browser" buttons for the loopback ports a background command listens on: three at
 * most, newest first, with the rest behind a toggle so a test run's twenty servers stay readable.
 * Callers keep their own styling; only the list, order and folding live here.
 */
export function BackgroundPortButtons({
  ports,
  disabled,
  onOpen,
  label,
  variant = "secondary",
  className,
  buttonClassName,
}: {
  ports: number[];
  disabled: boolean;
  onOpen: (port: number) => void;
  /** Button text; the port number is what keeps several buttons apart. */
  label: (port: number) => string;
  variant?: "ghost" | "secondary";
  className?: string;
  buttonClassName?: string;
}) {
  const t = useT();
  const ordered = useRecentPorts(ports);
  const [expanded, setExpanded] = useState(false);
  if (!ordered.length) return null;
  const shown = expanded ? ordered : ordered.slice(0, VISIBLE_PORTS);
  const hidden = ordered.length - VISIBLE_PORTS;
  return (
    <div className={className}>
      {shown.map((port) => (
        <Button
          key={port}
          variant={variant}
          className={buttonClassName}
          disabled={disabled}
          onClick={() => onOpen(port)}
          title={t("background.openPort", { port })}
        >
          {label(port)}
        </Button>
      ))}
      {hidden > 0 && (
        <Button
          variant="ghost"
          className={buttonClassName}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t("background.fewerPorts") : t("background.morePorts", { count: hidden })}
        </Button>
      )}
    </div>
  );
}
