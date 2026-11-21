import { FilePreviewScreen } from "../src/features/files/FilePreviewScreen.tsx";
import { PageTint } from "../src/theme/page-tint.tsx";

// Page colour: files come from runs, the Tasks area.
export default function Screen() {
  return (
    <PageTint name="orange">
      <FilePreviewScreen />
    </PageTint>
  );
}
