import { CreateGroupScreen } from "../../src/features/settings/CreateGroupScreen.tsx";
import { PageTint } from "../../src/theme/page-tint.tsx";

// Page colour: groups use the group colour.
export default function Screen() {
  return (
    <PageTint name="pink">
      <CreateGroupScreen />
    </PageTint>
  );
}
