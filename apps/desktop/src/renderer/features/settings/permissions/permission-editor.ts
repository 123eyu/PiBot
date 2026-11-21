import type { Permissions, PermissionsPatch } from "@pibot/protocol";
export interface PermissionEditorProps {
  data: Permissions;
  disabled: boolean;
  save(patch: PermissionsPatch): Promise<boolean>;
}
