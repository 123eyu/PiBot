import type { MethodResults } from "@pibot/protocol";
import { Overlay, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useState } from "react";
import { ProfessionFlow } from "./ProfessionFlow.tsx";

/**
 * The welcome wizard's profession step, any time later. The entry moved from
 * Settings · General next to the other way of adding a whole team; since 2026-11-13 that is the
 * .pibot import dialog (sidebar ＋ menu).
 */
export function ProfessionOverlay({ close }: { close(): void }) {
  const t = useT();
  const [done, setDone] = useState<MethodResults["builtin.create"]>();
  return (
    <Overlay icon="briefcase" tone="violet" title={t("builtin.settings.entry")} close={close}>
      {done ? (
        <>
          <p role="status">
            {t("builtin.preview.done", { groups: done.groupIds.length, bots: done.botIds.length })}
          </p>
          <div>
            <Button onClick={close}>{t("workspace.close")}</Button>
          </div>
        </>
      ) : (
        <ProfessionFlow
          skipLabel={t("common.cancel")}
          // The sidebar refreshes itself from the brain's created/sidebar events.
          onFinish={(result) => (result ? setDone(result) : close())}
        />
      )}
    </Overlay>
  );
}
