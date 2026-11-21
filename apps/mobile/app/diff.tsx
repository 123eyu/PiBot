import { DiffScreen } from "../src/features/changes/DiffScreen.tsx";
import { PageTint } from "../src/theme/page-tint.tsx";

// Page colour: a run's changes belong to the Tasks area.
export default function Screen() {
  return (
    <PageTint name="orange">
      <DiffScreen />
    </PageTint>
  );
}
