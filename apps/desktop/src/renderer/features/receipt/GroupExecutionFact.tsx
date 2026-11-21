import { groupExecutionText } from "@pibot/client-core";
import type { GroupExecutionReceipt } from "@pibot/protocol";
import { useT } from "@pibot/renderer-kit";
import { RelaxationDetails } from "./RelaxationDetails.tsx";
import styles from "./receipt.module.css";

/** A program fact stays visible even when the receipt's details are collapsed. */
export function GroupExecutionFact({ fact }: { fact: GroupExecutionReceipt }) {
  const t = useT();
  return (
    <div className={styles.execution}>
      <p>{groupExecutionText(fact, t)}</p>
      {fact.kind === "plan" && !!fact.relaxations?.length && (
        <RelaxationDetails items={fact.relaxations} />
      )}
    </div>
  );
}
