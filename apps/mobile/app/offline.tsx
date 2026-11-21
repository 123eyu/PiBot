import { OfflineSettingsScreen } from "../src/features/offline/OfflineSettingsScreen.tsx";
import { PageTint } from "../src/theme/page-tint.tsx";

// Page colour: the sketch's colour for phone replies.
export default function Screen() {
  return (
    <PageTint name="blue">
      <OfflineSettingsScreen />
    </PageTint>
  );
}
