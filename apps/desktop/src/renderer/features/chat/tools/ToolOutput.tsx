import { approvalStyles as styles, useT } from "@pibot/renderer-kit";
import { useLayoutEffect, useRef } from "react";
export function ToolOutput({
  output,
  expanded,
  history = false,
  note,
}: {
  output: string;
  expanded: boolean;
  history?: boolean;
  /** Replaces the retention note (an external agent's output is what it reported, capped). */
  note?: string;
}) {
  const t = useT();
  const root = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: output commits and reopening change the visible scroll height
  useLayoutEffect(() => {
    if (expanded && root.current && follow.current)
      root.current.scrollTop = root.current.scrollHeight;
  }, [output, expanded]);
  return (
    <div>
      <small className={styles.note}>
        {note ?? t(history ? "tool.historyOutputNote" : "tool.outputNote")}
      </small>
      <pre
        ref={root}
        className={styles.output}
        onScroll={(event) => {
          if (!expanded) return;
          const element = event.currentTarget;
          follow.current = element.scrollHeight - element.clientHeight - element.scrollTop < 24;
        }}
      >
        {output || t("tool.noOutput")}
      </pre>
    </div>
  );
}
