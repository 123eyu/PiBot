import { PairScreen } from "../src/features/pairing/PairScreen.tsx";
import { PageTint } from "../src/theme/page-tint.tsx";

// Page colour: pairing belongs to the Devices area.
export default function Screen() {
  return (
    <PageTint name="teal">
      <PairScreen />
    </PageTint>
  );
}
