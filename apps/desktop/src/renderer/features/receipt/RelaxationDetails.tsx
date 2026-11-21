import { relaxationText, visibleRelaxations } from "@pibot/client-core";
import type { PlanRelaxation } from "@pibot/protocol";
import { useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useState } from "react";

export function RelaxationDetails({ items }: { items: readonly PlanRelaxation[] }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const shown = visibleRelaxations(items, expanded);
  return (
    <div>
      <p>{t("receipt.relaxation.heading")}</p>
      <ul>
        {shown.items.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Immutable recorded history may repeat the same change in two replan rounds.
          <li key={`${item.stepId}:${item.targetId}:${index}`}>
            {item.stepTitle ?? item.stepId} · {relaxationText(item, t)}
          </li>
        ))}
      </ul>
      {items.length > 5 && (
        <Button aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded
            ? t("receipt.relaxation.hide")
            : t("receipt.relaxation.more", { count: shown.hidden })}
        </Button>
      )}
    </div>
  );
}
