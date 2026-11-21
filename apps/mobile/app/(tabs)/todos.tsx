import { TodosScreen } from "../../src/features/todos/TodosScreen.tsx";
import { BlurTarget } from "../../src/theme/glass.tsx";
import { PageTint } from "../../src/theme/page-tint.tsx";
import { TAB_TINT } from "../../src/theme/tint.ts";

// The floating tab bar blurs this page while it is in front (Android needs the target); the
// page colour is the tab's, for its primary buttons, the chosen day and the checks.
export default function Tab() {
  return (
    <PageTint name={TAB_TINT.todos}>
      <BlurTarget name="todos">
        <TodosScreen />
      </BlurTarget>
    </PageTint>
  );
}
