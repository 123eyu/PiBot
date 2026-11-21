import { RecordsScreen } from "../src/features/records/RecordsScreen.tsx";
import { PageTint } from "../src/theme/page-tint.tsx";

// Page colour: run records belong to the Tasks area.
export default function Screen() {
  return (
    <PageTint name="orange">
      <RecordsScreen />
    </PageTint>
  );
}
