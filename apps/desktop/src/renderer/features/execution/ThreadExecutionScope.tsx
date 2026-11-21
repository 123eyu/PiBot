import { useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { type ReactNode, useState } from "react";
import { OfficePreviewContext, useOfficePreview } from "../office/preview-context.tsx";
import { SidePane } from "../side-pane/SidePane.tsx";
import { useSidePane } from "../side-pane/use-side-pane.ts";
import styles from "./execution.module.css";
import { TasksPane } from "./TasksPane.tsx";
import { ExecutionContext, useExecutionWorkspace } from "./workspace.tsx";

/** A group thread has its own execution scope; its composer must never edit the main chat. */
export function ThreadExecutionScope({
  bots,
  conversationId,
  children,
}: {
  bots: readonly { id: string; name: string }[];
  conversationId: string;
  children: ReactNode;
}) {
  const t = useT(),
    pane = useSidePane(true);
  const officePreview = useOfficePreview(conversationId, pane);
  const [selected, setSelected] = useState<{ botId: string; taskId: string }>();
  const workspace = useExecutionWorkspace(bots, conversationId, (botId, taskId) => {
    setSelected(botId && taskId ? { botId, taskId } : undefined);
    pane.show("tasks");
  });
  return (
    <OfficePreviewContext.Provider value={officePreview.open}>
      <ExecutionContext.Provider value={workspace}>
        <div className={styles.threadScope}>
          <Button variant="ghost" onClick={() => workspace.open()}>
            {t("agentWork.tasks")}
          </Button>
          {children}
          <SidePane
            pane={pane}
            slots={[
              officePreview.slot,
              {
                id: "tasks",
                content: <TasksPane selected={selected} back={() => setSelected(undefined)} />,
              },
            ]}
          />
        </div>
      </ExecutionContext.Provider>
    </OfficePreviewContext.Provider>
  );
}
