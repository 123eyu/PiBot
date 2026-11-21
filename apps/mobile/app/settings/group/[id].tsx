import { GroupSettingsScreen } from "../../../src/features/settings/GroupSettingsScreen.tsx";
import { PageTint } from "../../../src/theme/page-tint.tsx";

// Page colour: groups use the group colour.
export default function Screen() {
  return (
    <PageTint name="pink">
      <GroupSettingsScreen />
    </PageTint>
  );
}
