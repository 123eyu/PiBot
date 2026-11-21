import { ProfileBrowser } from "@pibot/browser/ui";
import { ProfileComputer } from "@pibot/computer-use/ui";
import { useT } from "@pibot/renderer-kit";
import { usePermissions } from "../../settings/permissions/use-permissions.ts";
import {
  PermissionActivity,
  PermissionsContent,
} from "../../workspace/profile/PermissionsContent.tsx";
import { Grants } from "../../workspace/profile/ProfileGrants.tsx";

export function GroupPermissions({ groupId, groupName }: { groupId: string; groupName?: string }) {
  const t = useT();
  const state = usePermissions(undefined, groupId);
  return (
    <PermissionsContent
      state={state}
      description={t("execution.groupPermissionsNote")}
      computer={<ProfileComputer key={groupId} groupId={groupId} permissions={state} />}
      grants={<Grants groupId={groupId} />}
      browser={
        <ProfileBrowser
          key={groupId}
          group={{ id: groupId, name: groupName ?? t("group.panel") }}
        />
      }
      activity={<PermissionActivity groupId={groupId} />}
    />
  );
}
