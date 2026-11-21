import { SettingsPage } from "@pibot/renderer-kit";
import { GlobalRoutineSettings } from "@pibot/routines/ui";
import { BackgroundService } from "../background/BackgroundService.tsx";
import { BackgroundSettings } from "../background/BackgroundSettings.tsx";

/** Settings · Routines (例行任务): scheduling rules, life after quitting, the service. */
export function ScheduleSettings() {
  return (
    <SettingsPage>
      <GlobalRoutineSettings />
      <BackgroundSettings />
      <BackgroundService />
    </SettingsPage>
  );
}
