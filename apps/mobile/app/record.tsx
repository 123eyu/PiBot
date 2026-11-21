import { RecordDetailScreen } from "../src/features/records/RecordDetailScreen.tsx";
import { PageTint } from "../src/theme/page-tint.tsx";

// Page colour: run records belong to the Tasks area.
export default function Screen() {
  return (
    <PageTint name="orange">
      <RecordDetailScreen />
    </PageTint>
  );
}
