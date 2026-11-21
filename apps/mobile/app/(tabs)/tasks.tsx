import { TasksScreen } from "../../src/features/tasks/TasksScreen.tsx";
import { BlurTarget } from "../../src/theme/glass.tsx";
import { PageTint } from "../../src/theme/page-tint.tsx";
import { TAB_TINT } from "../../src/theme/tint.ts";

// The floating tab bar blurs this page while it is in front (Android needs the target); the
// page colour is the tab's, for its primary buttons and checks.
export default function Tab() {
  return (
    <PageTint name={TAB_TINT.tasks}>
      <BlurTarget name="tasks">
        <TasksScreen />
      </BlurTarget>
    </PageTint>
  );
}
