import { PhoneDataScreen } from "../src/features/phone-data/PhoneDataScreen.tsx";
import { PageTint } from "../src/theme/page-tint.tsx";

// Page colour: the sketch's colour for phone data.
export default function Screen() {
  return (
    <PageTint name="pink">
      <PhoneDataScreen />
    </PageTint>
  );
}
