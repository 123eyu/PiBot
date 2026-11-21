import type { MethodParams } from "@pibot/protocol";
import { useNavigation, useT } from "@pibot/renderer-kit";
import { Button, IconTile } from "@pibot/ui";

export function ShareTeamButton({
  target,
  disabled = false,
  role,
}: {
  target: MethodParams["teams.export"];
  disabled?: boolean;
  role?: "menuitem";
}) {
  const { openWorkspace } = useNavigation();
  const t = useT();
  return (
    <Button
      role={role}
      variant="pill"
      disabled={disabled}
      onClick={() => openWorkspace({ name: "share", target })}
    >
      {role === "menuitem" && <IconTile icon="send" tone="teal" size="sm" />}
      {t("workspace.share")}
    </Button>
  );
}
