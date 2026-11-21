import { RunChangesScreen } from "../../src/features/changes/RunChangesScreen.tsx";
import { PageTint } from "../../src/theme/page-tint.tsx";

// Page colour: a run's changes belong to the Tasks area.
export default function Screen() {
  return (
    <PageTint name="orange">
      <RunChangesScreen />
    </PageTint>
  );
}
