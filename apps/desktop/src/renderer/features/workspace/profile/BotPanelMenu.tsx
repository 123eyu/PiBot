import type { Bot } from "@pibot/protocol";
import {
  botPanelStyles as styles,
  useAction,
  useNavigation,
  useRpc,
  useT,
  useWorkspace,
} from "@pibot/renderer-kit";
import { useState } from "react";
import { DeleteConversationDialog } from "../topics/DeleteConversationDialog.tsx";
import { PanelMenu, type PanelMenuItem } from "./PanelMenu.tsx";

/**
 * The Bot panel's "⋯" menu (复制一个 · 导出 .pibot 文件 · 删除), which replaces the buttons
 * at the bottom of the old details tab. `notice` is the failure line shown at the top of the tab.
 */
export function useBotPanelMenu(bot: Bot | undefined, busy: boolean) {
  const t = useT();
  const { peer } = useRpc();
  const { closeBotPanel, navigate, openWorkspace } = useNavigation();
  const workspace = useWorkspace();
  const task = useAction();
  const [remove, setRemove] = useState(false);
  if (!bot) return { menu: null, notice: null };
  const disabled = busy || task.busy;
  const items: PanelMenuItem[] = [
    {
      id: "duplicate",
      label: t("workspace.duplicate"),
      disabled: disabled || task.error === "workspace.createUncertain" || !peer,
      run: () => {
        if (!peer) return;
        void task
          .run(() => peer.call("bots.duplicate", { botId: bot.id }))
          .then((copy) => {
            if (!copy) return;
            closeBotPanel();
            navigate({ name: "chat", botId: copy.id });
            void workspace.refresh();
          });
      },
    },
    {
      id: "export",
      label: t("panel.export"),
      disabled,
      run: () => openWorkspace({ name: "share", target: { botIds: [bot.id] } }),
    },
    // The main Bot cannot be deleted.
    ...(bot.isMain
      ? []
      : [
          {
            id: "delete",
            // The Bot menu's last item archives (it can be restored), so it reads as archive.
            icon: ["box", "red"] as const,
            label: t("workspace.archiveBot"),
            danger: true,
            disabled,
            run: () => setRemove(true),
          },
        ]),
  ];
  return {
    menu: <PanelMenu label={t("panel.more")} items={items} />,
    notice: (
      <>
        {task.error && (
          <p role="alert" className={styles.error}>
            {t(task.error)}
          </p>
        )}
        {remove && (
          <DeleteConversationDialog
            target={{ botId: bot.id }}
            close={() => setRemove(false)}
            deleted={() => {
              closeBotPanel();
              navigate({ name: "chat" });
              void workspace.refresh();
            }}
          />
        )}
      </>
    ),
  };
}
